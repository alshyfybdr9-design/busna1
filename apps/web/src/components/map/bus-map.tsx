"use client";
import { useEffect, useRef, useState } from "react";
import type { Map as MlMap, Marker, GeoJSONSource, LngLatBoundsLike } from "maplibre-gl";
import { cn } from "../ui/cn";

export interface MapBus {
  id: string;           // trip id
  lat: number;
  lng: number;
  heading?: number | null;
  label: string;        // e.g. "باص 1"
  tone: "brand" | "amber" | "red" | "gray";
  stale?: boolean;      // no fresh GPS
}
export interface MapPoint { id: string; lat: number; lng: number; label: string; kind: "stop" | "school" | "home" }

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";
const RIYADH: [number, number] = [46.6753, 24.7136];

const toneColor = { brand: "rgb(var(--brand-rgb))", amber: "#F59E0B", red: "#DC2626", gray: "#94A3B8" };

function busEl(b: MapBus, selected: boolean): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.setAttribute("aria-label", b.label);
  el.style.cssText = "background:none;border:0;padding:0;cursor:pointer";
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:2px;opacity:${b.stale ? 0.55 : 1}">
      <div style="position:relative;width:${selected ? 44 : 38}px;height:${selected ? 44 : 38}px;border-radius:999px;background:${toneColor[b.tone]};
        display:grid;place-items:center;box-shadow:0 0 0 ${selected ? 5 : 3}px #fff, 0 6px 16px rgba(15,23,42,.3)">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>
        </svg>
        ${b.heading != null ? `<div style="position:absolute;inset:-9px;transform:rotate(${b.heading}deg)"><div style="margin:0 auto;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:8px solid ${toneColor[b.tone]}"></div></div>` : ""}
      </div>
      <span style="font:600 11px 'IBM Plex Sans Arabic',sans-serif;background:#fff;color:#0f172a;padding:1px 6px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.15);white-space:nowrap">${escapeHtml(b.label)}</span>
    </div>`;
  return el;
}

function pointEl(p: MapPoint): HTMLElement {
  const el = document.createElement("div");
  const color = p.kind === "school" ? "#0F172A" : p.kind === "home" ? "#2563EB" : "#64748B";
  const icon = p.kind === "school" ? "🏫" : p.kind === "home" ? "🏠" : "";
  el.title = p.label;
  el.innerHTML = icon
    ? `<div style="width:30px;height:30px;border-radius:10px;background:#fff;display:grid;place-items:center;font-size:16px;box-shadow:0 0 0 2px ${color},0 4px 10px rgba(0,0,0,.2)">${icon}</div>`
    : `<div style="width:12px;height:12px;border-radius:999px;background:#fff;box-shadow:0 0 0 3px ${color}"></div>`;
  return el;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function BusMap({ buses = [], points = [], path, selectedId, onSelect, onMapClick, className, fitKey, center }: {
  buses?: MapBus[];
  points?: MapPoint[];
  path?: [number, number][];        // [lng, lat][]
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Click on empty map (e.g. to place a stop). */
  onMapClick?: (lat: number, lng: number) => void;
  className?: string;
  /** Change this value to re-fit the map to its content. */
  fitKey?: string;
  center?: [number, number];        // [lng, lat]
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const busMarkers = useRef(new Map<string, Marker>());
  const pointMarkers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onClickRef = useRef(onMapClick);
  onClickRef.current = onMapClick;

  // init
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ml = await import("maplibre-gl");
      if (cancelled || !container.current) return;
      try {
        const m = new ml.Map({
          container: container.current,
          style: STYLE,
          center: center ?? RIYADH,
          zoom: 12,
          attributionControl: { compact: true },
        });
        m.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");
        m.on("load", () => {
          m.addSource("path", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({ id: "path-casing", type: "line", source: "path", paint: { "line-color": "#fff", "line-width": 8 }, layout: { "line-cap": "round", "line-join": "round" } });
          m.addLayer({ id: "path", type: "line", source: "path", paint: { "line-color": "#0E9F6E", "line-width": 4 }, layout: { "line-cap": "round", "line-join": "round" } });
          setReady(true);
        });
        m.on("click", (e) => onClickRef.current?.(e.lngLat.lat, e.lngLat.lng));
        m.on("error", (e) => { if (!m.loaded() && (e as { error?: { status?: number } }).error) setFailed(true); });
        map.current = m;
      } catch {
        setFailed(true);
      }
    })();
    const markers = busMarkers.current;
    return () => {
      cancelled = true;
      markers.clear();
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // buses
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (async () => {
      const ml = await import("maplibre-gl");
      const seen = new Set<string>();
      for (const b of buses) {
        seen.add(b.id);
        const existing = busMarkers.current.get(b.id);
        if (existing) existing.remove();
        const el = busEl(b, b.id === selectedId);
        el.addEventListener("click", (ev) => { ev.stopPropagation(); onSelectRef.current?.(b.id); });
        const mk = new ml.Marker({ element: el, anchor: "center" }).setLngLat([b.lng, b.lat]).addTo(m);
        busMarkers.current.set(b.id, mk);
      }
      for (const [id, mk] of busMarkers.current) if (!seen.has(id)) { mk.remove(); busMarkers.current.delete(id); }
    })();
  }, [buses, ready, selectedId]);

  // static points
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (async () => {
      const ml = await import("maplibre-gl");
      pointMarkers.current.forEach((p) => p.remove());
      pointMarkers.current = points.map((p) => new ml.Marker({ element: pointEl(p) }).setLngLat([p.lng, p.lat]).addTo(m));
    })();
  }, [points, ready]);

  // path
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource("path") as GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: path && path.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: path } }] : [],
    });
  }, [path, ready]);

  // fit
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const coords: [number, number][] = [
      ...buses.map((b) => [b.lng, b.lat] as [number, number]),
      ...points.map((p) => [p.lng, p.lat] as [number, number]),
      ...(path ?? []),
    ];
    if (coords.length === 0) return;
    if (coords.length === 1) { m.easeTo({ center: coords[0], zoom: 14 }); return; }
    const lngs = coords.map((c) => c[0]); const lats = coords.map((c) => c[1]);
    const bounds: LngLatBoundsLike = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
    m.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  return (
    <div className={cn("relative overflow-hidden bg-slate-100", className)}>
      <div ref={container} className="absolute inset-0" role="region" aria-label="خريطة الباصات" />
      {!ready && !failed && <div className="absolute inset-0 animate-pulse bg-slate-200/60" aria-hidden />}
      {failed && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-muted">
          تعذّر تحميل الخريطة. تحقق من الاتصال بالإنترنت.
        </div>
      )}
    </div>
  );
}
