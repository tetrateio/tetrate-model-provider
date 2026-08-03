import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_' },
            ],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
        },
    },
    {
        ignores: ['out/**', 'node_modules/**'],
    }
);
