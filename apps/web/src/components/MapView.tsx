/**
 * خريطة قابلة لتبديل المزود: عنوان البلاطات والإسناد من متغيرات البيئة.
 * تنبيه: خوادم tile.openstreetmap.org للاستخدام الخفيف فقط وفق سياستها؛ في الإنتاج
 * استخدم مزودًا تجاريًا (MapTiler/Mapbox/Stadia...) أو استضافة ذاتية عبر VITE_MAP_TILE_URL.
 */
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect } from 'react';

const TILE_URL = (import.meta.env.VITE_MAP_TILE_URL as string | undefined) ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) ?? '&copy; OpenStreetMap contributors';
export const MAP_PROVIDER_IS_DEFAULT = !import.meta.env.VITE_MAP_TILE_URL;

const DEFAULT_CENTER: [number, number] = [24.7136, 46.6753];

function pin(color: string, label: string) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};color:#fff;border-radius:999px;padding:2px 8px;font:600 12px 'IBM Plex Sans Arabic',sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);white-space:nowrap;transform:translate(-50%,-50%)">${label}</div>`,
    iconSize: [0, 0],
  });
}

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  color?: string;
  popup?: React.ReactNode;
}

function FitBounds({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 14);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onClick(e.latlng.lat, e.latlng.lng) });
  return null;
}

export function MapView({ markers, trail, onMapClick, tall, fit = true }: {
  markers: MapMarker[];
  trail?: Array<[number, number]>;
  onMapClick?: (lat: number, lng: number) => void;
  tall?: boolean;
  fit?: boolean;
}) {
  const pts: Array<[number, number]> = [...markers.map((m) => [m.lat, m.lng] as [number, number]), ...(trail ?? [])];
  return (
    <div>
      <div className={`map ${tall ? 'tall' : ''}`}>
        <MapContainer center={pts[0] ?? DEFAULT_CENTER} zoom={12} style={{ height: '100%', width: '100%' }}>
          <TileLayer url={TILE_URL} attribution={ATTRIBUTION} />
          {trail && trail.length > 1 && <Polyline positions={trail} pathOptions={{ color: '#16a34a', weight: 4, opacity: 0.7 }} />}
          {markers.map((m) => (
            <Marker key={m.id} position={[m.lat, m.lng]} icon={pin(m.color ?? '#16a34a', m.label)}>
              {m.popup && <Popup>{m.popup}</Popup>}
            </Marker>
          ))}
          {fit && <FitBounds points={pts} />}
          {onMapClick && <ClickHandler onClick={onMapClick} />}
        </MapContainer>
      </div>
      {MAP_PROVIDER_IS_DEFAULT && (
        <div className="map-note">بلاطات OpenStreetMap العامة للتطوير فقط — اضبط VITE_MAP_TILE_URL لمزود إنتاجي.</div>
      )}
    </div>
  );
}
