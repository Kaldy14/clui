export const PROJECT_ADD_REQUEST_EVENT = "clui:project-add-request";

export function requestProjectAdd(): void {
  window.dispatchEvent(new Event(PROJECT_ADD_REQUEST_EVENT));
}

export function subscribeProjectAddRequests(listener: () => void): () => void {
  window.addEventListener(PROJECT_ADD_REQUEST_EVENT, listener);
  return () => window.removeEventListener(PROJECT_ADD_REQUEST_EVENT, listener);
}
