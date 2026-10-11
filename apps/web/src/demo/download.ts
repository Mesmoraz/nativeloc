/** The online demo: a download link to the API, answered by the in-page server instead of the network. */
export async function demoDownload(path: string) {
  const res = await (await import('./runtime')).demoFetch(path);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
