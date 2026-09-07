/** @type {import('next').NextConfig} */
const nextConfig = {
	serverExternalPackages: ["better-sqlite3", "sqlite-vec", "sqlite-vec-windows-x64"],
	experimental: {
		serverActions: {
			bodySizeLimit: "200mb",
		},
	},
};

export default nextConfig;