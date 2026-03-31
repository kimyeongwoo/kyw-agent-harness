/**
 * Checks whether a given PID refers to a live process.
 * On Unix, process.kill(pid, 0) sends no signal but verifies the process exists.
 * EPERM / EACCES mean the process is alive but owned by another user.
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}
