import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createScanSession,
  createSubmitOnce,
  selectQrEngine,
  startQrScanner,
  stopMediaStream,
  type BarcodeDetectorLike,
} from './qr-scanner';

function mockStream() {
  const stopped: string[] = [];
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          stopped.push('track');
        },
      },
    ],
  } as unknown as MediaStream;
  return { stream, stopped };
}

describe('QR engine selection', () => {
  it('uses BarcodeDetector when available', () => {
    assert.equal(selectQrEngine({ barcodeDetectorAvailable: true }), 'barcode-detector');
  });

  it('uses zxing fallback when BarcodeDetector is missing', () => {
    assert.equal(selectQrEngine({ barcodeDetectorAvailable: false }), 'zxing');
  });

  it('uses zxing when BarcodeDetector cannot read qr_code', () => {
    assert.equal(
      selectQrEngine({ barcodeDetectorAvailable: true, supportedFormats: ['pdf417'] }),
      'zxing'
    );
  });
});

describe('QR submit-once and cleanup', () => {
  it('scanner submits token only once', () => {
    const seen: string[] = [];
    const submit = createSubmitOnce((token) => seen.push(token));
    assert.equal(submit('TOKEN-A'), true);
    assert.equal(submit('TOKEN-A'), false);
    assert.equal(submit('TOKEN-B'), false);
    assert.deepEqual(seen, ['TOKEN-A']);
  });

  it('stops camera tracks on session stop', () => {
    const { stream, stopped } = mockStream();
    const session = createScanSession(stream);
    session.stop();
    assert.equal(session.stopped, true);
    assert.deepEqual(stopped, ['track']);
    assert.equal(session.accept('TOKEN'), false);
  });

  it('stopMediaStream is safe after success or cancel', () => {
    const { stream, stopped } = mockStream();
    stopMediaStream(stream);
    stopMediaStream(stream);
    stopMediaStream(null);
    assert.deepEqual(stopped, ['track', 'track']);
  });
});

describe('QR scanner paths', () => {
  it('BarcodeDetector available path submits once and stops camera', async () => {
    const { stream, stopped } = mockStream();
    const seen: string[] = [];
    let detects = 0;
    const FakeDetector = class {
      async detect() {
        detects += 1;
        return detects === 1 ? [{ rawValue: 'BD-TOKEN' }] : [{ rawValue: 'BD-TOKEN-2' }];
      }
    } as unknown as BarcodeDetectorLike;

    const frames: Array<() => void> = [];
    const handle = await startQrScanner({
      video: {} as HTMLVideoElement,
      stream,
      barcodeDetector: FakeDetector,
      onDetect: (token) => seen.push(token),
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => undefined,
      createZxingReader: async () => {
        throw new Error('zxing should not run when BarcodeDetector works');
      },
    });
    assert.equal(handle.engine, 'barcode-detector');
    frames[0]();
    await Promise.resolve();
    await Promise.resolve();
    if (frames[1]) {
      frames[1]();
      await Promise.resolve();
    }
    assert.deepEqual(seen, ['BD-TOKEN']);
    assert.deepEqual(stopped, ['track']);
  });

  it('fallback scanner path uses zxing and submits once', async () => {
    const { stream, stopped } = mockStream();
    const seen: string[] = [];
    let zxingStopped = false;
    const handle = await startQrScanner({
      video: {} as HTMLVideoElement,
      stream,
      barcodeDetector: null,
      onDetect: (token) => seen.push(token),
      createZxingReader: async () => ({
        decodeFromStream: async (_stream, _video, callback) => {
          callback({ getText: () => 'ZXING-TOKEN' });
          callback({ getText: () => 'ZXING-TOKEN-2' });
          return {
            stop: () => {
              zxingStopped = true;
            },
          };
        },
      }),
    });
    assert.equal(handle.engine, 'zxing');
    assert.deepEqual(seen, ['ZXING-TOKEN']);
    handle.stop();
    assert.equal(zxingStopped, true);
    assert.ok(stopped.includes('track'));
  });

  it('scanner cleanup stops camera after cancel', async () => {
    const { stream, stopped } = mockStream();
    let zxingStopped = false;
    const handle = await startQrScanner({
      video: {} as HTMLVideoElement,
      stream,
      barcodeDetector: null,
      onDetect: () => undefined,
      createZxingReader: async () => ({
        decodeFromStream: async () => ({
          stop: () => {
            zxingStopped = true;
          },
        }),
      }),
    });
    handle.stop();
    assert.equal(zxingStopped, true);
    assert.deepEqual(stopped, ['track']);
  });
});
