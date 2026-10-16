// @hey-api/openapi-ts: src/api/ from the repository's openapi.json (`npm run generate`,
// `make clients` at the root). Don't edit src/api/ by hand.
import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
	input: '../../openapi.json',
	output: { path: 'src/api', importFileExtension: '.js' },
	plugins: ['@hey-api/client-fetch', '@hey-api/typescript', { name: '@hey-api/sdk', auth: true }]
});
