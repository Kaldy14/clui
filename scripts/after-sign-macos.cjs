const { join } = require("node:path");

function resolveMacAppPath(context) {
  const appOutDir = context?.appOutDir;
  const productFilename = context?.packager?.appInfo?.productFilename;

  if (!appOutDir || !productFilename) {
    throw new Error("electron-builder afterSign context is missing the macOS app path.");
  }

  return join(appOutDir, `${productFilename}.app`);
}

function createAfterSign(loadNotarizer = () => import("./notarize-macos-app.mjs")) {
  return async function afterSign(context) {
    if (context?.electronPlatformName !== "darwin") {
      return;
    }

    const { notarizeMacosApp } = await loadNotarizer();
    await notarizeMacosApp({ appPath: resolveMacAppPath(context) });
  };
}

exports.resolveMacAppPath = resolveMacAppPath;
exports.createAfterSign = createAfterSign;
exports.default = createAfterSign();
