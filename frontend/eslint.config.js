import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

/**
 * ESLint 9 flat config.
 *
 * react-hooks 规则是这里的重点: 前面几处"陈旧闭包 / 依赖不全"的问题
 * (深链 effect 里调用每次渲染新建的 changeMode) 都是它能直接抓出来的。
 */
export default tseslint.config(
  { ignores: ['dist/**', 'public/**', 'node_modules/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 类型边界已由 tsc 把关; 这里只提示, 不阻塞构建
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
)
