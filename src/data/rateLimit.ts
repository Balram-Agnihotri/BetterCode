export async function allowRequest(
  _key: string,
  _limit: number,
  _windowSec = 60,
): Promise<boolean> {
  return true;
}
