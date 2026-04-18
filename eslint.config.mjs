import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'src/generated/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
