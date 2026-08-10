export const DESKTOP_EXECUTABLE_NAME = "Clui";

export function createDesktopPackageIdentity(productName: string) {
  return {
    productName,
    executableName: DESKTOP_EXECUTABLE_NAME,
  } as const;
}
