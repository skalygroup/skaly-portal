import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Global ignores. next-env.d.ts and db.types.ts are generated files
  // (Next.js and kysely-codegen respectively) and must not be linted/edited.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      // Generated design-sync build output (Claude Design shims/bundles) —
      // not authored here, ships its own @next/next disables we don't register.
      '**/.ds-build/**',
      '**/next-env.d.ts',
      '**/db.types.ts',
    ],
  },

  // Base TypeScript config for all files
  ...tseslint.configs.recommended,

  // Source files
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      import: importPlugin,
      // React Hooks linting. Registered here so inline
      // `eslint-disable react-hooks/*` directives resolve (otherwise ESLint v9
      // errors "rule definition not found"). Harmless for non-React packages —
      // the rules only fire on hooks/components, which they don't contain.
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // Import ordering
      'import/order': [
        'warn',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'type',
          ],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'warn',

      // React Hooks — real bugs (conditional hooks) are errors; missing-deps
      // are warnings, consistent with the import/order + TS rules above.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // TypeScript rules
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports' },
      ],
    },
  },

  // Test file overrides
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Database migrations, seeds & CLI tooling scripts: Kysely's migration
  // API is schema-agnostic and documented to use `Kysely<any>`, and the
  // scripts issue raw catalog queries (`as any`), so `any` is idiomatic.
  {
    files: ['**/migrations/**/*.ts', '**/seeds/**/*.ts', '**/scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  // Type declaration files: ambient/module-augmentation declarations
  // commonly need `any` and empty interfaces for framework augmentation.
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
];
