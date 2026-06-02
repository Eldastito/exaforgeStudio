export async function apiFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('zappflow_token');
  const headers = new Headers(options.headers || {});
  
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  
  options.headers = headers;
  return fetch(url, options);
}
