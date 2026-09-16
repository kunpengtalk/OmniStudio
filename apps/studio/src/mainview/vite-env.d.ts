declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

// 小应用页面以原文导入（见 app/apps/pages.ts）：原文塞进 sandbox iframe 的 srcdoc。
declare module "*.html?raw" {
  const html: string;
  export default html;
}
