export async function readResponse(response) {
  let data;
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
    data = await response.json();
  } catch {
    throw new Error('We could not reach the service. Please try again in a moment.');
  }
  if (!response.ok) {
    const raw = data?.error?.message;
    const message = typeof raw === 'string' && !/<[^>]+>|&(?:lt|gt|#\d+);/.test(raw)
      ? raw : 'Something went wrong. Please try again in a moment.';
    throw Object.assign(new Error(message), { code: data?.error?.code });
  }
  return data;
}
