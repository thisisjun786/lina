// Forge is a development tool. The packaged application contains only dist + package metadata.
module.exports = {
	packagerConfig: {
		asar: true,
		name: "Lina",
		executableName: "lina-desktop",
		appBundleId: "app.lina.desktop",
		prune: true,
		ignore: (path) =>
			path !== "" &&
			path !== "/package.json" &&
			path !== "/dist" &&
			!path.startsWith("/dist/"),
	},
	makers: [
		{
			name: "@electron-forge/maker-zip",
			platforms: ["darwin", "linux", "win32"],
		},
	],
};
