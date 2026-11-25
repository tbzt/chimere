// Copies files that must be served as-is at the site root.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public', { recursive: true });
copyFileSync(
  'node_modules/coi-serviceworker/coi-serviceworker.min.js',
  'public/coi-serviceworker.min.js',
);
