import { useEffect, useRef } from 'react';
import type { TemporalFramePair } from '../engine';

export type PreviewBackgroundStatus = NonNullable<TemporalFramePair['backgroundStatus']>;
export type PreviewForegroundStatus = NonNullable<TemporalFramePair['foregroundStatus']>;

/** Each endpoint is a complete opaque frame. Keep the lower one opaque and
 * composite only the upper frame, so interpolation never darkens the image. */
interface Props {
  time: number;
  resolve: (time: number) => TemporalFramePair | null | Promise<TemporalFramePair | null>;
  onPending: (pending: boolean) => void;
  onError: (error: unknown) => void;
  onBackgroundStatus?: (status: PreviewBackgroundStatus | undefined) => void;
  onForegroundStatus?: (status: PreviewForegroundStatus | undefined) => void;
}

export function TemporalPreview({ time, resolve, onPending, onError, onBackgroundStatus, onForegroundStatus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fonts = useRef<HTMLStyleElement>(null);
  const metadata = useRef<HTMLDivElement>(null);
  const sharedDefinitions = useRef<SVGDefsElement>(null);
  const sharedElements = useRef(new Map<string, Element>());
  const layers = useRef<[HTMLDivElement | null, HTMLDivElement | null]>([null, null]);
  const keys = useRef<Array<string | undefined>>([]);
  const latest = useRef(0);
  const previousResolver = useRef(resolve);
  const appliedFonts = useRef('');
  const appliedMetadata = useRef('');
  const appliedDefinitions = useRef('');
  const appliedBackgroundStatus = useRef<string | undefined>(undefined);
  const appliedForegroundStatus = useRef<string | undefined>(undefined);

  useEffect(() => {
    const request = ++latest.current;
    if (previousResolver.current !== resolve) {
      previousResolver.current = resolve;
      keys.current = [];
    }
    const apply = (pair: TemporalFramePair | null) => {
      if (request !== latest.current) return;
      if (!pair) { onPending(false); return; }
      if (fonts.current && pair.fontCss !== appliedFonts.current) {
        fonts.current.textContent = pair.fontCss;
        appliedFonts.current = pair.fontCss;
      }
      if (metadata.current && pair.fontMetadata !== appliedMetadata.current) {
        metadata.current.innerHTML = pair.fontMetadata;
        appliedMetadata.current = pair.fontMetadata;
      }
      const background = pair;
      const definitions = background.sharedDefinitions ?? '';
      if (sharedDefinitions.current && definitions !== appliedDefinitions.current) {
        sharedDefinitions.current.innerHTML = definitions;
        appliedDefinitions.current = definitions;
        sharedElements.current = new Map([...sharedDefinitions.current.querySelectorAll('[id]')].map(element => [element.id, element]));
      }
      for (const transform of background.sharedTransforms ?? []) {
        sharedElements.current.get(transform.id)?.setAttribute('transform', `matrix(${transform.matrix.join(' ')})`);
        for (const [index, channel] of ['R', 'G', 'B'].entries()) {
          const component = sharedElements.current.get(`${transform.colorId}-${channel}`);
          if (component) { component.setAttribute('slope', String(transform.gain[index])); component.setAttribute('intercept', String(transform.bias[index])); }
        }
        sharedElements.current.get(`${transform.id}-opacity`)?.setAttribute('opacity', String(transform.opacity));
      }
      for (const transform of pair.sharedMatrixTransforms ?? []) {
        sharedElements.current.get(transform.id)?.setAttribute('transform', `matrix(${transform.matrix.join(' ')})`);
      }
      for (const transform of pair.sharedOpacityTransforms ?? []) {
        sharedElements.current.get(transform.id)?.setAttribute('opacity', String(transform.opacity));
      }
      const statusKey = background.backgroundStatus ? JSON.stringify(background.backgroundStatus) : '';
      if (statusKey !== appliedBackgroundStatus.current) {
        appliedBackgroundStatus.current = statusKey;
        onBackgroundStatus?.(background.backgroundStatus);
      }
      const foregroundStatusKey = pair.foregroundStatus ? JSON.stringify(pair.foregroundStatus) : '';
      if (foregroundStatusKey !== appliedForegroundStatus.current) {
        appliedForegroundStatus.current = foregroundStatusKey;
        onForegroundStatus?.(pair.foregroundStatus);
      }
      // A previous upper frame becomes the next lower frame without parsing it
      // again. Only the newly observed endpoint receives fresh SVG markup.
      let fromSlot = keys.current.indexOf(pair.from.key);
      if (fromSlot < 0) fromSlot = pair.to && keys.current[0] === pair.to.key ? 1 : 0;
      const toSlot = 1 - fromSlot;
      const lower = layers.current[fromSlot]!, upper = layers.current[toSlot]!;
      if (keys.current[fromSlot] !== pair.from.key) {
        lower.innerHTML = pair.from.svg;
        keys.current[fromSlot] = pair.from.key;
      }
      lower.style.zIndex = '0'; lower.style.opacity = '1'; lower.style.visibility = 'visible';
      lower.dataset.sampleTime = String(pair.from.time);
      if (pair.to) {
        if (keys.current[toSlot] !== pair.to.key) {
          upper.innerHTML = pair.to.svg;
          keys.current[toSlot] = pair.to.key;
        }
        upper.style.zIndex = '1'; upper.style.opacity = String(pair.mix); upper.style.visibility = 'visible';
        upper.dataset.sampleTime = String(pair.to.time);
        upper.style.pointerEvents = pair.mix >= 0.5 ? 'auto' : 'none';
        lower.style.pointerEvents = pair.mix < 0.5 ? 'auto' : 'none';
      } else {
        upper.replaceChildren(); keys.current[toSlot] = undefined;
        upper.style.visibility = 'hidden'; upper.style.pointerEvents = 'none'; lower.style.pointerEvents = 'auto';
      }
      if (host.current) {
        host.current.dataset.renderTime = String(pair.time);
        host.current.dataset.blendMix = String(pair.mix);
        host.current.dataset.frameFrom = String(pair.from.time);
        host.current.dataset.frameTo = pair.to ? String(pair.to.time) : '';
        host.current.dataset.backgroundMode = background.backgroundStatus?.mode ?? '';
        host.current.dataset.backgroundSupported = String(background.backgroundStatus?.supported ?? false);
        host.current.dataset.backgroundTracks = background.backgroundStatus?.activeTrackIds.join(',') ?? '';
        host.current.dataset.foregroundMode = pair.foregroundStatus?.mode ?? '';
        host.current.dataset.foregroundSupported = String(pair.foregroundStatus?.supported ?? false);
        host.current.dataset.foregroundTracks = pair.foregroundStatus?.activeTrackIds.join(',') ?? '';
      }
      onPending(false);
    };
    try {
      const result = resolve(time);
      if (result instanceof Promise) {
        onPending(true);
        void result.then(apply).catch(error => { if (request === latest.current) { onPending(false); onError(error); } });
      } else apply(result);
    } catch (error) { onPending(false); onError(error); }
    return () => { latest.current++; };
  }, [time, resolve, onPending, onError, onBackgroundStatus, onForegroundStatus]);

  useEffect(() => () => onPending(false), [onPending]);
  return <div ref={host} data-testid="stage-preview" className="svg-preview temporal-preview">
    <style ref={fonts} />
    <div ref={metadata} hidden aria-hidden="true" />
    <svg className="temporal-shared-definitions" width="0" height="0" aria-hidden="true" focusable="false"><defs ref={sharedDefinitions} /></svg>
    <div ref={element => { layers.current[0] = element; }} className="temporal-frame" />
    <div ref={element => { layers.current[1] = element; }} className="temporal-frame" />
  </div>;
}
