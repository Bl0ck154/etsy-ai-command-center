export function assertRuntimeFileOwner({
  currentUid,
  fileUid,
  label = 'runtime file',
} = {}) {
  if (!Number.isInteger(currentUid) || !Number.isInteger(fileUid)) return;
  if (currentUid === fileUid) return;

  const error = new Error(
    `Run --apply as the existing ${label} owner `
    + `(file uid ${fileUid}, current uid ${currentUid}), never as a different user`,
  );
  error.code = 'MESSAGE_RUNTIME_FILE_OWNER_MISMATCH';
  throw error;
}
