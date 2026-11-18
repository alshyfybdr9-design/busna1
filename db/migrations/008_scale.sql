-- =====================================================================
-- تحسينات الأداء بعد اختبار الضغط (300 ألف طالب)
-- =====================================================================

-- آخر موقع لكل رحلة على صف الرحلة نفسه: قراءة صف واحد بدل البحث في ملايين النقاط
alter table trips
  add column last_lat double precision,
  add column last_lng double precision,
  add column last_accuracy_m real,
  add column last_speed_mps real;

update trips t set last_lat = l.lat, last_lng = l.lng, last_accuracy_m = l.accuracy_m
from (select distinct on (trip_id) trip_id, lat, lng, accuracy_m from bus_locations
      where trip_id in (select id from trips where status = 'in_progress')
      order by trip_id, recorded_at desc) l
where l.trip_id = t.id;

-- منع تكرار نفس الحدث في الطابور (مثل تنبيه «الباص اقترب» قبل أن يُعالج)
alter table outbox_events add column dedupe_key text;
create unique index outbox_events_dedupe on outbox_events (dedupe_key) where dedupe_key is not null;
grant delete on outbox_events to busna_worker;

-- رحلات جارية: يستخدمها فحص الاقتراب وفحوص السلامة الدورية
create index if not exists trips_in_progress on trips (id) where status = 'in_progress';
