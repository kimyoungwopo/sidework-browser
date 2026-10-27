import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**','dist-*/**','release/**','qa/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files:['**/*.ts','**/*.tsx'], rules:{ '@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}] } },
  { files:['**/*.mjs'], languageOptions:{ecmaVersion:2023,sourceType:'module',globals:{console:'readonly',process:'readonly',setTimeout:'readonly',clearTimeout:'readonly',URL:'readonly',Buffer:'readonly',document:'readonly',window:'readonly',fetch:'readonly'}} }
);
