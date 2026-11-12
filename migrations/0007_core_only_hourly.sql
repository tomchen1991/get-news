-- Low-frequency channels keep their Thu/Sun morning searches only.
-- Do not change morning weekdays, query lists, or Jev scoring priority.
UPDATE site_topics SET refresh_weight=0,refresh_credit=0 WHERE id IN ('ev','wuhan','health');
