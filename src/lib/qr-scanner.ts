export type QrEngine = 'barcode-detector' | 'zxing';

export type BarcodeDetectorLike = new (options: { formats: string[] }) => {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

export type ZxingControls = { stop: () => void };

export type ZxingResult = { getText: () => string };

export type ZxingReader = {
  decodeFromStream: (
    stream: MediaStream,
    video: HTMLVideoElement,
    callback: (result: ZxingResult | undefined, error?: unknown, controls?: ZxingControls) => void
  ) => Promise<ZxingControls>;
};

export function selectQrEngine(input: {
  barcodeDetectorAvailable: boolean;
  supportedFormats?: string[];
}): QrEngine {
  if (!input.barcodeDetectorAvailable) return 'zxing';
  if (input.supportedFormats && !input.supportedFormats.includes('qr_code')) return 'zxing';
  return 'barcode-detector';
}

export function createSubmitOnce(submit: (token: string) => void) {
  let used = false;
  return (token: string) => {
    const value = token.trim();
    if (used || !value) return false;
    used = true;
    submit(value);
    return true;
  };
}

export function stopMediaStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function createScanSession(stream: MediaStream | null) {
  let stopped = false;
  let onDetect: (token: string) => void = () => undefined;
  const accept = createSubmitOnce((token) => onDetect(token));

  return {
    get stopped() {
      return stopped;
    },
    setOnDetect(handler: (token: string) => void) {
      onDetect = handler;
    },
    accept(token: string) {
      if (stopped) return false;
      return accept(token);
    },
    stop() {
      stopped = true;
      stopMediaStream(stream);
    },
  };
}

type StartOptions = {
  video: HTMLVideoElement;
  stream: MediaStream;
  onDetect: (token: string) => void;
  onEngineUnavailable?: () => void;
  barcodeDetector?: BarcodeDetectorLike | null;
  createZxingReader?: () => Promise<ZxingReader>;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
};

export async function startQrScanner(options: StartOptions): Promise<{
  stop: () => void;
  engine: QrEngine | 'none';
}> {
  const session = createScanSession(options.stream);
  session.setOnDetect(options.onDetect);
  let frameId = 0;
  let zxingControls: ZxingControls | null = null;
  const requestFrame =
    options.requestFrame ??
    ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => cb()) : 0));
  const cancelFrame =
    options.cancelFrame ??
    ((id) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    });

  const stop = () => {
    session.stop();
    cancelFrame(frameId);
    try {
      zxingControls?.stop();
    } catch {
      /* already stopped */
    }
  };

  const engine = selectQrEngine({
    barcodeDetectorAvailable: Boolean(options.barcodeDetector),
  });

  if (engine === 'barcode-detector' && options.barcodeDetector) {
    try {
      const detector = new options.barcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (session.stopped) return;
        try {
          const codes = await detector.detect(options.video);
          const value = codes[0]?.rawValue;
          if (value) {
            const accepted = session.accept(value);
            if (accepted) {
              stop();
              return;
            }
          }
        } catch {
          /* keep scanning */
        }
        if (!session.stopped) {
          frameId = requestFrame(() => void tick());
        }
      };
      frameId = requestFrame(() => void tick());
      return { stop, engine: 'barcode-detector' };
    } catch {
      /* fall through to zxing */
    }
  }

  try {
    const factory =
      options.createZxingReader ??
      (async () => {
        const mod = await import('@zxing/browser');
        return new mod.BrowserQRCodeReader() as unknown as ZxingReader;
      });
    const reader = await factory();
    zxingControls = await reader.decodeFromStream(options.stream, options.video, (result) => {
      if (session.stopped || !result) return;
      const value = result.getText();
      if (!value) return;
      const accepted = session.accept(value);
      if (accepted) stop();
    });
    if (session.stopped) {
      try {
        zxingControls.stop();
      } catch {
        /* already stopped */
      }
    }
    return { stop, engine: 'zxing' };
  } catch {
    options.onEngineUnavailable?.();
    return { stop, engine: 'none' };
  }
}
