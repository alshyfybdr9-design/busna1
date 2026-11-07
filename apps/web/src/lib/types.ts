// Domain types mirroring supabase/migrations. Keep in sync with the schema.

export type TripPeriod = "morning" | "afternoon";
export type TripStatus = "scheduled" | "started" | "in_progress" | "completed" | "cancelled";
export type AttendanceStatus = "pending" | "boarded" | "absent" | "dropped";
export type BusStatus = "active" | "maintenance" | "out_of_service";
export type TransportStatus = "active" | "suspended" | "withdrawn";
export type StaffRole = "driver" | "supervisor";
export type MemberRole = "owner" | "admin" | "viewer";
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentCategory = "breakdown" | "accident" | "traffic" | "student_behavior" | "medical" | "other";

export interface School {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  timezone: string;
  city: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  settings: { approach_radius_m?: number; late_threshold_min?: number };
}

export interface Staff {
  id: string;
  school_id: string;
  user_id: string | null;
  role: StaffRole;
  full_name: string;
  phone: string;
  national_id: string | null;
  license_number: string | null;
  license_expiry: string | null;
  photo_url: string | null;
  status: "active" | "suspended";
  notes: string | null;
}

export interface Guardian {
  id: string;
  school_id: string;
  user_id: string | null;
  full_name: string;
  phone: string;
  phone_alt: string | null;
  email: string | null;
  notify_push: boolean;
  notify_sms: boolean;
  status: "active" | "suspended";
}

export interface Bus {
  id: string;
  school_id: string;
  code: string;
  plate_number: string;
  vehicle_type: string;
  model_year: number | null;
  capacity: number;
  default_driver_id: string | null;
  default_supervisor_id: string | null;
  status: BusStatus;
  gps_source: "driver_app" | "device";
  gps_device_id: string | null;
  notes: string | null;
}

export interface Student {
  id: string;
  school_id: string;
  student_number: string;
  full_name: string;
  grade: string | null;
  section: string | null;
  photo_url: string | null;
  home_address: string | null;
  home_lat: number | null;
  home_lng: number | null;
  pickup_label: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  bus_id: string | null;
  transport_status: TransportStatus;
  notes: string | null;
  /** Opaque token printed as the card's QR (see lib/student-qr.ts). */
  qr_token: string;
}

export interface Route {
  id: string;
  school_id: string;
  name: string;
  period: TripPeriod;
  bus_id: string | null;
  driver_id: string | null;
  supervisor_id: string | null;
  weekdays: number[];
  departure_time: string;
  start_label: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_label: string | null;
  end_lat: number | null;
  end_lng: number | null;
  active: boolean;
}

export interface RouteStop {
  id: string;
  route_id: string;
  seq: number;
  name: string;
  lat: number;
  lng: number;
  offset_min: number;
}

export interface Trip {
  id: string;
  school_id: string;
  route_id: string | null;
  name: string;
  trip_date: string;
  period: TripPeriod;
  bus_id: string | null;
  driver_id: string | null;
  supervisor_id: string | null;
  status: TripStatus;
  scheduled_start: string;
  start_label: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_label: string | null;
  end_lat: number | null;
  end_lng: number | null;
  started_at: string | null;
  started_by: string | null;
  arrived_at: string | null;
  arrived_kind: "school" | "end_point" | null;
  completed_at: string | null;
  completed_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  delay_minutes: number;
  delay_reason: string | null;
  emergency_active: boolean;
}

export interface TripStop {
  id: string;
  trip_id: string;
  seq: number;
  name: string;
  lat: number;
  lng: number;
  planned_at: string | null;
  arrived_at: string | null;
}

export interface TripStudent {
  id: string;
  trip_id: string;
  student_id: string;
  trip_stop_id: string | null;
  status: AttendanceStatus;
  boarded_at: string | null;
  dropped_at: string | null;
  drop_place: "school" | "home" | "stop" | null;
  absent_at: string | null;
}

export interface TripEvent {
  id: string;
  trip_id: string;
  type: string;
  actor_user_id: string | null;
  actor_role: string | null;
  student_id: string | null;
  lat: number | null;
  lng: number | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface LivePosition {
  trip_id: string;
  school_id: string;
  bus_id: string | null;
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  recorded_at: string;
}

export interface Notification {
  id: string;
  school_id: string;
  guardian_id: string | null;
  student_id: string | null;
  trip_id: string | null;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface Incident {
  id: string;
  school_id: string;
  trip_id: string | null;
  bus_id: string | null;
  reporter_role: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  description: string;
  status: "open" | "acknowledged" | "resolved";
  resolution: string | null;
  created_at: string;
}

export interface ParentRequest {
  id: string;
  school_id: string;
  guardian_id: string;
  student_id: string | null;
  kind: "feedback" | "complaint" | "pickup_change" | "contact" | "absence_notice";
  body: string;
  status: "open" | "in_review" | "resolved" | "rejected";
  response: string | null;
  created_at: string;
}

export interface MyAccess {
  user_id: string;
  platform_admin: boolean;
  schools: { school_id: string; slug: string; name: string; logo_url: string | null; primary_color: string; role: MemberRole }[];
  staff: { staff_id: string; school_id: string; school_name: string; role: StaffRole; full_name: string }[];
  guardian: boolean;
}

export interface DashboardStats {
  date: string;
  students_total: number;
  students_on_bus: number;
  students_at_school: number;
  students_home: number;
  students_absent: number;
  trips_total: number;
  trips_active: number;
  trips_completed: number;
  trips_scheduled: number;
  trips_cancelled: number;
  trips_delayed: number;
  trips_not_started_late: number;
  emergencies: number;
  buses_total: number;
  buses_available: number;
  buses_on_trip: number;
  buses_stopped: number;
  buses_over_capacity: number;
  drivers: number;
  supervisors: number;
  open_incidents: number;
  open_requests: number;
}

export interface ParentChildTrip {
  trip_id: string;
  name: string;
  period: TripPeriod;
  status: TripStatus;
  scheduled_start: string;
  started_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  delay_minutes: number;
  delay_reason: string | null;
  cancel_reason: string | null;
  emergency_active: boolean;
  attendance: AttendanceStatus;
  boarded_at: string | null;
  dropped_at: string | null;
  drop_place: "school" | "home" | "stop" | null;
  stop_name: string | null;
  stop_planned_at: string | null;
  bus: { code: string; plate_number: string } | null;
  driver_name: string | null;
  supervisor: { name: string; phone: string } | null;
  trackable: boolean;
}

export interface ParentChild {
  student_id: string;
  full_name: string;
  grade: string | null;
  section: string | null;
  photo_url: string | null;
  transport_status: TransportStatus;
  pickup_label: string | null;
  can_track: boolean;
  school: { id: string; name: string; logo_url: string | null; primary_color: string; timezone: string };
  bus: { code: string; plate_number: string } | null;
  trips: ParentChildTrip[];
}

export interface ParentTracking {
  trackable: boolean;
  reason?: "no_trip_today" | "tracking_disabled" | "trip_not_started" | "trip_cancelled" | "trip_ended" | "not_boarded" | "absent" | "dropped";
  trip_id?: string;
  trip_status?: TripStatus;
  period?: TripPeriod;
  boarded_at?: string;
  position?: { lat: number; lng: number; heading: number | null; speed: number | null; recorded_at: string } | null;
  destination?: { label: string; lat: number | null; lng: number | null };
  distance_m?: number | null;
  eta_minutes?: number | null;
  delay_minutes?: number;
  delay_reason?: string | null;
  path?: [number, number][];
}
