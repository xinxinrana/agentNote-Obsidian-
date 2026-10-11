declare module "electron" {
  export const shell: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
  };
}
