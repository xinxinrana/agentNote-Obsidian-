declare module "electron" {
  export const shell: {
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): void;
    openPath(path: string): Promise<string>;
  };
}
