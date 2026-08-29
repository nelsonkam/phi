import { createContext, useContext, type ReactNode } from "react";

// Scope for resolving workspace file links: the message's channel, an
// optional explicit root (after a search redirect), and the directory of
// a markdown file being viewed so relative hrefs stay next to that file.
export interface FileLinkScopeValue {
  channelId?: string;
  root?: string;
  baseDir?: string;
  threadId?: string;
}

const FileLinkContext = createContext<FileLinkScopeValue>({});

export function FileLinkScope({
  channelId,
  root,
  baseDir,
  threadId,
  children,
}: FileLinkScopeValue & { children: ReactNode }) {
  return (
    <FileLinkContext.Provider value={{ channelId, root, baseDir, threadId }}>
      {children}
    </FileLinkContext.Provider>
  );
}

export function useFileLinkScope(): FileLinkScopeValue {
  return useContext(FileLinkContext);
}

// Channel pages own a single file viewer so chip clicks can URL-sync without
// stacking a second dialog on top of the deep-link/popover one. Nested
// FileLinkScope must not clobber this — it lives on its own context.
export interface OpenWorkspaceFile {
  path: string;
  root?: string;
  parentThreadId?: string;
  fragment?: string;
}

const FileViewerOutletContext = createContext<
  ((doc: OpenWorkspaceFile) => void) | null
>(null);

export function FileViewerOutlet({
  onOpen,
  children,
}: {
  onOpen: (doc: OpenWorkspaceFile) => void;
  children: ReactNode;
}) {
  return (
    <FileViewerOutletContext.Provider value={onOpen}>
      {children}
    </FileViewerOutletContext.Provider>
  );
}

export function useFileViewerOutlet(): ((doc: OpenWorkspaceFile) => void) | null {
  return useContext(FileViewerOutletContext);
}
