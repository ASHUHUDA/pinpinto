export { };

declare global {
  type PinPintoBrowserTarget = 'chrome' | 'firefox';
  const __PINPINTO_BROWSER_TARGET__: PinPintoBrowserTarget;
  const __PINPINTO_E2E__: boolean;

  interface Window {
    pinVaultContentLoaded: boolean;
    pinVaultContent: any;
  }
}

