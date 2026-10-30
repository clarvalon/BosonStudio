export function removeEntry(store, kind, id) {
  const entries = kind === 'asset' ? store.data.assets : kind === 'job' ? store.data.jobs : null;
  const entry = entries?.find(item => item.id === id && !item.deletedAt);
  if (!entry) throw new Error('This gallery entry is unavailable.');
  if (kind === 'job' && ['preparing', 'queued', 'running'].includes(entry.status)) throw new Error('Cancel the active generation before removing it.');
  // Recoverable removal. Retain local bytes and historical references for Undo.
  entry.deletedAt = new Date().toISOString();
  return { kind, id, removed: true };
}

export function restoreEntry(store, kind, id) {
  const entries = kind === 'asset' ? store.data.assets : kind === 'job' ? store.data.jobs : null;
  const entry = entries?.find(item => item.id === id && item.deletedAt);
  if (!entry) throw new Error('This removed entry is unavailable.');
  delete entry.deletedAt;
  return { kind, id, restored: true };
}
