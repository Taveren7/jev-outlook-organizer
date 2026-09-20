export interface LayoutState {
  id: string; categories: string[]; isRead: boolean; parentFolderId: string;
  flag: { flagStatus: string; [key: string]: unknown }; '@odata.etag': string;
}
export function assertLayoutState(expected: LayoutState, actual: LayoutState): void {
  if (expected.id !== actual.id || expected['@odata.etag'] !== actual['@odata.etag'] ||
    expected.parentFolderId !== actual.parentFolderId || expected.isRead !== actual.isRead ||
    JSON.stringify(expected.categories.slice().sort()) !== JSON.stringify(actual.categories.slice().sort()) ||
    JSON.stringify(expected.flag) !== JSON.stringify(actual.flag)) throw Error('Message changed; review again');
}
