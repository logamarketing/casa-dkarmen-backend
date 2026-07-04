-- Seed — Casa D'Karmen menú del día for 2026-07-04.
-- Source: Edgar's Google Doc "Menú – Casa D'Karmen" (updated 2026-07-03),
-- verified live by Cowork.
--
-- Idempotent: upserts on (service_date, category, item_name), so re-running
-- this migration updates the day in place and the unique constraint holds.
--
-- LIVE CORRECTION applied: comidas are $120 (Karmen's old hardcoded prompt
-- said $110 and was undercharging on real calls). The DB is now authoritative.
-- Item names are kept verbatim from the source doc.

insert into public.daily_menu (service_date, category, item_name, price, sides, sort_order) values
  -- COMIDA — 120 each
  ('2026-07-04','comida','Cazuela',120,'arroz',1),
  ('2026-07-04','comida','Pollo con Fetuccini',120,'ensalada verde y frijol',2),
  ('2026-07-04','comida','Costillas con Chile',120,'sopa fría y frijol',3),
  ('2026-07-04','comida','Tamales Gratinados',120,'frijolitos',4),
  ('2026-07-04','comida','Chile relleno de queso',120,'arroz y frijol',5),
  ('2026-07-04','comida','Lasaña',120,'ensalada verde y frijol',6),
  ('2026-07-04','comida','Papa rellena',120,'sopa fría y frijol',7),
  ('2026-07-04','comida','Ensalada de Pollo',120,'sopa fría y frijol',8),
  ('2026-07-04','comida','Pastel de Pollo',120,'sopa fría y frijol',9),
  ('2026-07-04','comida','Sopa de Tortilla',120,'totopos',10),
  ('2026-07-04','comida','Lomo en Crema de Champiñón',120,'sopa fría y frijol',11),
  ('2026-07-04','comida','Nachos con Carne con Cochinita Pibil',120,NULL,12),
  ('2026-07-04','comida','Enchiladas Suizas',120,'ensalada verde y frijol',13),
  ('2026-07-04','comida','Bistec Ranchero',120,'arroz y frijol',14),
  ('2026-07-04','comida','Chilaquiles Rojos',120,'ensalada verde y frijol',15),
  ('2026-07-04','comida','Filete Empanizado',120,'ensalada verde, arroz y salsa',16),
  ('2026-07-04','comida','Pechuga a la Plancha',120,'ensalada verde, sopa fría y frijol',17),
  ('2026-07-04','comida','Tostadas (pollo o carne, 3 piezas)',120,'consomé',18),
  ('2026-07-04','comida','Gorditas (pollo o carne, 3 piezas)',120,'consomé',19),
  ('2026-07-04','comida','Flautas (pollo o carne, 3 piezas)',120,'consomé',20),
  ('2026-07-04','comida','Tacos Dorados (pollo o carne, 3 piezas)',120,'consomé',21),
  -- BEBIDA — 25 each
  ('2026-07-04','bebida','Té de Jazmín',25,NULL,1),
  ('2026-07-04','bebida','Agua de Jamaica',25,NULL,2),
  ('2026-07-04','bebida','Agua de Tamarindo',25,NULL,3),
  ('2026-07-04','bebida','Coca-Cola 400 ml',25,NULL,4),
  ('2026-07-04','bebida','Coca-Cola Zero 400 ml',25,NULL,5),
  ('2026-07-04','bebida','Coca-Cola Light 400 ml',25,NULL,6),
  ('2026-07-04','bebida','Fanta de Fresa',25,NULL,7),
  ('2026-07-04','bebida','Fanta de Naranja',25,NULL,8),
  ('2026-07-04','bebida','Soda de Manzana',25,NULL,9),
  ('2026-07-04','bebida','Soda de Sprite',25,NULL,10),
  ('2026-07-04','bebida','Soda de Fresca',25,NULL,11),
  -- EXTRA — price varies
  ('2026-07-04','extra','Aguacate extra',15,NULL,1),
  ('2026-07-04','extra','Tortillas extra',5,NULL,2),
  ('2026-07-04','extra','Totopos extra',5,NULL,3),
  ('2026-07-04','extra','Cuchara extra',0,NULL,4),
  ('2026-07-04','extra','Tenedor extra',0,NULL,5),
  ('2026-07-04','extra','Poner mayonesa',0,NULL,6)
on conflict (service_date, category, item_name) do update
  set price        = excluded.price,
      sides        = excluded.sides,
      is_available = excluded.is_available,
      sort_order   = excluded.sort_order;
