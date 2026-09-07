import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    // 第三方参考/固定源码与构建产物不参与 lint：.ref/ 为上游仓库参考目录，
    // src/vendor/ 为固定构建产物，src/vendor-build/ 为项目维护的第三方 fork 源码。
    ignores: [".ref/**", "src/vendor/**", "src/vendor-build/**"],
  },
];

export default eslintConfig;