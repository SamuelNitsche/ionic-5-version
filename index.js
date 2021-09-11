const beautify = require("js-beautify").html;
const child = require("child_process");
const detectIndent = require("detect-indent");
const dottie = require("dottie");
const flattenDeep = require("lodash.flattendeep");
const fs = require("fs");
const list = require("./util").list;
const log = require("./util").log;
const path = require("path");
const plist = require("plist");
const pSettle = require("p-settle");
const resolveFrom = require("resolve-from");
const semver = require("semver");
const stripIndents = require("common-tags/lib/stripIndents");
const unique = require("lodash.uniq");
const Xcode = require("pbxproj-dom/xcode").Xcode;

/**
 * Custom type definition for Promises
 * @typedef Promise
 * @property {*} result See the implementing function for the resolve type and description
 * @property {Error} result Rejection error object
 */

const env = {
	target: process.env.RNV && list(process.env.RNV)
};

/**
 * Returns default values for some options, namely android/ios file/folder paths
 * @private
 * @return {Object} Defaults
 */
function getDefaults() {
	return {
		android: "android/app/build.gradle",
		ios: "ios/App"
	};
}

/**
 * Returns Info.plist filenames
 * @private
 * @param {Xcode} xcode Opened Xcode project file
 * @return {Array} Plist filenames
 */
function getPlistFilenames(xcode) {
	return unique(
		flattenDeep(
			xcode.document.projects.map(project => {
				return project.targets.filter(Boolean).map(target => {
					return target.buildConfigurationsList.buildConfigurations.map(
						config => {
							return config.ast.value.get("buildSettings").get("INFOPLIST_FILE")
								.text;
						}
					);
				});
			})
		)
	);
}

/**
 * Returns numerical version code for a given version name
 * @private
 * @return {Number} e.g. returns 1002003 for given version 1.2.3
 */
function generateVersionCode(versionName) {
	const major = semver.major(versionName);
	const minor = semver.minor(versionName);
	const patch = semver.patch(versionName);

	return 10 ** 6 * major + 10 ** 3 * minor + patch;
}

/**
 * Returns the new version code based on program options
 * @private
 * @return {Number} the new version code
 */
function getNewVersionCode(programOpts, versionCode, versionName, resetBuild) {
	if (resetBuild) {
		return 1;
	}

	if (programOpts.setBuild) {
		return programOpts.setBuild;
	}

	if (programOpts.generateBuild) {
		return generateVersionCode(versionName);
	}

	return versionCode ? versionCode + 1 : 1;
}

/**
 * CFBundleShortVersionString must be a string composed of three period-separated integers.
 * @private
 * @param {String} versionName The full version string
 * @return {String} e.g. returns '1.2.3' for given '1.2.3-beta.1'. Returns `versionName` if no match is found.
 */
function getCFBundleShortVersionString(versionName) {
	const match =
		versionName && typeof versionName === "string"
			? versionName.match(/\d*\.\d*.\d*/g)
			: [];
	return match && match[0] ? match[0] : versionName;
}

/**
 * Versions your app
 * @param {Object} program commander/CLI-style options, camelCased
 * @param {string} projectPath Path to your React Native project
 * @return {Promise<string|Error>} A promise which resolves with the last commit hash
 */
function version(program, projectPath) {
	const prog = Object.assign({}, getDefaults(), program || {});

	const projPath = path.resolve(
		process.cwd(),
		projectPath || prog.args[0] || ""
	);

	const programOpts = Object.assign({}, prog, {
		android: path.join(projPath, prog.android),
		ios: path.join(projPath, prog.ios)
	});

	const targets = [].concat(programOpts.target, env.target).filter(Boolean);
	var appPkg;

	try {
		appPkg = require(path.join(projPath, "package.json"));
	} catch (err) {
		if (err.message === "Cannot find module 'react-scripts'") {
			log({
				style: "red",
				text: `Is this the right folder? ${err.message} in ${projPath}`
			});
		} else {
			log({
				style: "red",
				text: err.message
			});

			log({
				style: "red",
				text:
					"Is this the right folder? Looks like there isn't a package.json here"
			});
		}

		log({
			style: "yellow",
			text: "Pass the project path as an argument, see --help for usage"
		});

		if (program.outputHelp) {
			program.outputHelp();
		}

		process.exit(1);
	}

	var android;
	var ios;

	if (!targets.length || targets.indexOf("android") > -1) {
		android = new Promise(function (resolve, reject) {
			log({ text: "Versioning Android..." }, programOpts.quiet);

			var gradleFile;

			try {
				gradleFile = fs.readFileSync(programOpts.android, "utf8");
			} catch (err) {
				reject([
					{
						style: "red",
						text: "No gradle file found at " + programOpts.android
					},
					{
						style: "yellow",
						text: 'Use the "--android" option to specify the path manually'
					}
				]);
			}

			if (!programOpts.incrementBuild) {
				gradleFile = gradleFile.replace(
					/versionName (["'])(.*)["']/,
					"versionName $1" + appPkg.version + "$1"
				);
			}

			if (!programOpts.neverIncrementBuild) {
				gradleFile = gradleFile.replace(/versionCode (\d+)/, function (
					match,
					cg1
				) {
					const newVersionCodeNumber = getNewVersionCode(
						programOpts,
						parseInt(cg1, 10),
						appPkg.version
					);

					return "versionCode " + newVersionCodeNumber;
				});
			}

			fs.writeFileSync(programOpts.android, gradleFile);

			log({ text: "Android updated" }, programOpts.quiet);
			resolve();
		});
	}

	if (!targets.length || targets.indexOf("ios") > -1) {
		ios = new Promise(function (resolve, reject) {
			log({ text: "Versioning iOS..." }, programOpts.quiet);

			// Find any folder ending in .xcodeproj
			const xcodeProjects = fs
				.readdirSync(programOpts.ios)
				.filter(file => /\.xcodeproj$/i.test(file));

			if (xcodeProjects.length < 1) {
				throw new Error(`Xcode project not found in "${programOpts.ios}"`);
			}

			const projectFolder = path.join(programOpts.ios, xcodeProjects[0]);
			const xcode = Xcode.open(path.join(projectFolder, "project.pbxproj"));
			const plistFilenames = getPlistFilenames(xcode);

			xcode.document.projects.forEach(project => {
				!programOpts.neverIncrementBuild &&
					project.targets.filter(Boolean).forEach(target => {
						target.buildConfigurationsList.buildConfigurations.forEach(
							config => {
								if (target.name === appPkg.name) {
									const CURRENT_PROJECT_VERSION = getNewVersionCode(
										programOpts,
										parseInt(
											config.ast.value
												.get("buildSettings")
												.get("CURRENT_PROJECT_VERSION").text,
											10
										),
										appPkg.version,
										programOpts.resetBuild
									);

									config.patch({
										buildSettings: {
											CURRENT_PROJECT_VERSION
										}
									});
								}
							}
						);
					});

				const plistFiles = plistFilenames.map(filename => {
					return fs.readFileSync(
						path.join(programOpts.ios, filename),
						"utf8"
					);
				});

				const parsedPlistFiles = plistFiles.map(file => {
					return plist.parse(file);
				});

				parsedPlistFiles.forEach((json, index) => {
					fs.writeFileSync(
						path.join(programOpts.ios, plistFilenames[index]),
						plist.build(
							Object.assign(
								{},
								json,
								!programOpts.incrementBuild
									? {
										CFBundleShortVersionString: getCFBundleShortVersionString(
											appPkg.version
										)
									}
									: {},
								!programOpts.neverIncrementBuild
									? {
										CFBundleVersion: getNewVersionCode(
											programOpts,
											parseInt(json.CFBundleVersion, 10),
											appPkg.version,
											programOpts.resetBuild
										).toString()
									}
									: {}
							)
						)
					);
				});

				plistFilenames.forEach((filename, index) => {
					const indent = detectIndent(plistFiles[index]);

					fs.writeFileSync(
						path.join(programOpts.ios, filename),
						stripIndents`
							<?xml version="1.0" encoding="UTF-8"?>
							<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
							<plist version="1.0">` +
						"\n" +
						beautify(
							fs
								.readFileSync(path.join(programOpts.ios, filename), "utf8")
								.match(/<dict>[\s\S]*<\/dict>/)[0],
							Object.assign(
								{ end_with_newline: true },
								indent.type === "tab"
									? { indent_with_tabs: true }
									: { indent_size: indent.amount }
							)
						) +
						stripIndents`
							</plist>` +
						"\n"
					);
				});
			});

			xcode.save();

			log({ text: "iOS updated" }, programOpts.quiet);
			resolve();
		});
	}

	return pSettle([android, ios].filter(Boolean))
		.then(function (result) {
			const errs = result
				.filter(function (item) {
					return item.isRejected;
				})
				.map(function (item) {
					return item.reason;
				});

			if (errs.length) {
				errs
					.reduce(function (a, b) {
						return a.concat(b);
					}, [])
					.forEach(function (err) {
						if (program.outputHelp) {
							log(
								Object.assign({ style: "red", text: err.toString() }, err),
								programOpts.quiet
							);
						}
					});

				if (program.outputHelp) {
					program.outputHelp();
				}

				throw errs
					.map(function (errGrp, index) {
						return errGrp
							.map(function (err) {
								return err.text;
							})
							.join(", ");
					})
					.join("; ");
			}

			const gitCmdOpts = {
				cwd: projPath
			};

			if (
				programOpts.amend ||
				(process.env.npm_lifecycle_event &&
					process.env.npm_lifecycle_event.indexOf("version") > -1 &&
					!programOpts.neverAmend)
			) {
				const latestTag =
					(programOpts.amend ||
						process.env.npm_config_git_tag_version ||
						process.env.npm_config_version_git_tag) &&
					!programOpts.skipTag &&
					semver.valid(
						semver.coerce(
							child
								.execSync("git log -1 --pretty=%s", gitCmdOpts)
								.toString()
								.trim()
						)
					) &&
					child
						.execSync("git describe --exact-match HEAD", gitCmdOpts)
						.toString()
						.trim();

				log({ text: "Amending..." }, programOpts.quiet);

				switch (process.env.npm_lifecycle_event) {
					case "version":
						child.spawnSync(
							"git",
							["add"].concat(
								[programOpts.android, programOpts.ios]
							),
							gitCmdOpts
						);

						break;

					case "postversion":
					default:
						child.execSync("git commit -a --amend --no-edit", gitCmdOpts);

						if (latestTag) {
							log({ text: "Adjusting Git tag..." }, programOpts.quiet);

							child.execSync(
								`git tag -af ${latestTag} -m ${latestTag}`,
								gitCmdOpts
							);
						}
				}
			}

			log(
				{
					style: "green",
					text: "Done"
				},
				programOpts.quiet
			);

			if (programOpts.neverAmend) {
				return true;
			}

			return child.execSync("git log -1 --pretty=%H", gitCmdOpts).toString();
		})
		.catch(function (err) {
			if (process.env.RNV_ENV === "ava") {
				console.error(err);
			}

			log({
				style: "red",
				text: "Done, with errors."
			});

			process.exit(1);
		});
}

module.exports = {
	getCFBundleShortVersionString: getCFBundleShortVersionString,
	getDefaults: getDefaults,
	getPlistFilenames: getPlistFilenames,
	version: version
};
