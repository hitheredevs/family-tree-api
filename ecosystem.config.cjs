module.exports = {
	apps: [
		{
			name: 'family-tree-api',
			cwd: __dirname,
			script: 'dist/server.js',
			interpreter: 'node',
			exec_mode: 'fork',
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: '500M',
			env: {
				NODE_ENV: 'production',
			},
		},
	],
};
