type LinkSource = {
  getInitialURL(): Promise<string | null>;
  addEventListener(type: "url", listener: (event: { url: string }) => void): { remove(): void };
};

export function subscribeCameraLinks(links: LinkSource, openCamera: () => void) {
  let active = true;
  let handledLive = false;
  const matches = (url: string | null) => url !== null && /^nepeel:\/\/camera\/?(?:[?#].*)?$/i.test(url);
  const subscription = links.addEventListener("url", ({ url }) => {
    if (active && matches(url)) {
      handledLive = true;
      openCamera();
    }
  });
  void links.getInitialURL().then(url => {
    if (active && !handledLive && matches(url)) openCamera();
  }).catch(() => undefined);
  return () => {
    active = false;
    subscription.remove();
  };
}
