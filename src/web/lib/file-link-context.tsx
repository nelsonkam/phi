import { createContext, useContext, type ReactNode } from "react";

// Scope for resolving workspace file links: the message's channel, an
// optional explicit root (after a search redirect), and the directory of
// a markdown file being viewed so relative hrefs stay next to that file.
export interface FileLinkScopeValue {
  channelId?: string;
  root?: string;
  baseDir?: string;
}

const FileLinkContext = createContext<FileLinkScopeValue>({});

export function FileLinkScope({
  channelId,
  root,
  baseDir,
  children,
}: FileLinkScopeValue & { children: ReactNode }) {
  return (
    <FileLinkContext.Provider value={{ channelId, root, baseDir }}>
      {children}
    </FileLinkContext.Provider>
  );
}

export function useFileLinkScope(): FileLinkScopeValue {
  return useContext(FileLinkContext);
}
