import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { SortWall, Warehouse } from '../types/database';

/**
 * Minimal admin/test-data tools. There is no real Store API integration yet
 * (docs/TECHNICAL_DESIGN_DOCUMENT.md Section 3.1) — these forms call the
 * `admin_create_*` RPCs (Section 12.3/20.1) so you can create a warehouse,
 * sort wall, pigeon holes, a warehouse gate code, and test orders directly
 * from the Supabase SQL editor once, then generate ongoing test data here.
 */
export function AdminPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [sortWalls, setSortWalls] = useState<SortWall[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [generatedCodes, setGeneratedCodes] = useState<
    { label: string; value: string }[]
  >([]);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 5000);
  };

  const loadRefData = async () => {
    const [w, sw] = await Promise.all([supabase.from('warehouses').select('*'), supabase.from('sort_walls').select('*')]);
    setWarehouses((w.data as unknown as Warehouse[]) ?? []);
    setSortWalls((sw.data as unknown as SortWall[]) ?? []);
  };

  useEffect(() => {
    void loadRefData();
  }, []);

  // PostgREST reports a missing function as a schema-cache lookup failure,
  // named by whichever set of arguments the client actually sent (it does
  // this rather than saying "wrong argument count" because RPC calls are
  // matched by argument NAME, not position). We only expect to hit this
  // specific case when p_is_fragile/p_store_name are sent to a project that
  // hasn't applied migration 0005 yet — everything else should surface as a
  // normal error.
  const isMissingFunctionError = (message: string) =>
    /could not find the function/i.test(message) || message.includes('PGRST202');

  const createOrder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Capture the form element itself before any `await`: per the DOM spec,
    // `Event.currentTarget` reverts to null once the event finishes
    // dispatching, which happens long before an async handler resumes after
    // its first `await` — reading `e.currentTarget` later throws
    // "Cannot read properties of null". This is not React event pooling
    // (removed in React 17+); it's the underlying native Event object.
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const isFragile = form.get('fragile') === 'on';
    const storeName = (form.get('storeName') as string | null)?.trim() || null;
    const usedExtendedArgs = isFragile || !!storeName;

    const baseArgs = {
      p_store_external_ref: form.get('storeRef'),
      p_bag_count: Number(form.get('bagCount')),
      p_store_floor: form.get('floor') || null,
      p_store_zone: form.get('zone') || null,
      p_store_address: form.get('address') || null,
    };
    const extendedArgs = {
      ...baseArgs,
      ...(isFragile ? { p_is_fragile: true } : {}),
      ...(storeName ? { p_store_name: storeName } : {}),
    };

    let { data, error } = await supabase.rpc('admin_create_order_v1', extendedArgs);

    // Migration 0005 hasn't been applied to this project yet: fall back to
    // the base 6-argument call automatically instead of blocking order
    // creation entirely. This is exactly the case a beginner hits by simply
    // leaving the pre-filled "Store display name" field in place.
    let fellBack = false;
    if (error && usedExtendedArgs && isMissingFunctionError(error.message)) {
      fellBack = true;
      ({ data, error } = await supabase.rpc('admin_create_order_v1', baseArgs));
    }

    if (error) {
      notify(`Failed: ${error.message}`);
    } else {
      const order = data as {
        external_order_ref: string;
        shared_bag_qr_code_id: string | null;
      };
      notify(
        fellBack
          ? `Created order ${order.external_order_ref}. Store name/fragile were skipped — run migration 0005_order_fragile.sql to enable them.`
          : `Created order ${order.external_order_ref}`
      );
      if (order.shared_bag_qr_code_id) {
        const { data: qr } = await supabase
          .from('qr_codes')
          .select('code_value')
          .eq('id', order.shared_bag_qr_code_id)
          .single();
        if (qr) {
          setGeneratedCodes((current) => [
            {
              label: `Bag code for ${order.external_order_ref} (same code on every bag)`,
              value: (qr as { code_value: string }).code_value,
            },
            ...current,
          ]);
        }
      }
    }
    formEl.reset();
  };

  const createHoles = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const { data, error } = await supabase.rpc('admin_create_pigeon_holes_v1', {
      p_sort_wall_id: form.get('sortWallId'),
      p_count: Number(form.get('count')),
      p_prefix: form.get('prefix') || 'P',
    });
    if (error) {
      notify(`Failed: ${error.message}`);
    } else {
      const holes = (data as { hole_number: string; qr_code_id: string | null }[]) ?? [];
      notify(`Created ${holes.length} pigeon holes`);
      const qrIds = holes.flatMap((hole) => (hole.qr_code_id ? [hole.qr_code_id] : []));
      if (qrIds.length > 0) {
        const { data: qrRows } = await supabase
          .from('qr_codes')
          .select('id, code_value')
          .in('id', qrIds);
        const codeById = new Map(
          ((qrRows as { id: string; code_value: string }[] | null) ?? []).map((qr) => [
            qr.id,
            qr.code_value,
          ])
        );
        setGeneratedCodes((current) => [
          ...holes.flatMap((hole) =>
            hole.qr_code_id && codeById.has(hole.qr_code_id)
              ? [
                  {
                    label: `Pigeon hole ${hole.hole_number}`,
                    value: codeById.get(hole.qr_code_id)!,
                  },
                ]
              : []
          ),
          ...current,
        ]);
      }
    }
  };

  const createGate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const { data, error } = await supabase.rpc('admin_create_warehouse_gate_v1', {
      p_warehouse_id: form.get('warehouseId'),
    });
    if (error) {
      notify(`Failed: ${error.message}`);
    } else {
      const value = (data as { code_value: string }).code_value;
      notify(`Gate code created: ${value}`);
      setGeneratedCodes((current) => [
        { label: 'Warehouse gate code', value },
        ...current,
      ]);
    }
  };

  return (
    <div className="admin-screen">
      {toast && <div className="toast">{toast}</div>}

      <header className="panel-heading">
        <div>
          <span className="panel-eyebrow">Platform controls</span>
          <h1>Admin</h1>
          <p>Create test orders and manage the physical QR setup for this MVP.</p>
        </div>
      </header>

      {generatedCodes.length > 0 && (
        <section className="generated-codes">
          <h2>Generated test codes</h2>
          <p className="hint">
            Keep this page open or copy these values. On a scanner screen, tap
            &quot;Can&apos;t scan? Enter code manually&quot; and paste the matching value.
          </p>
          {generatedCodes.map((code, index) => (
            <div className="generated-code" key={`${code.label}-${index}`}>
              <strong>{code.label}</strong>
              <code>{code.value}</code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(code.value);
                  notify('Code copied.');
                }}
              >
                Copy
              </button>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Create test order</h2>
        <p className="hint">
          Stand-in for a real Store API webhook (Section 3.1/7.2). Generates the shared order-level
          QR code and the expected bag count.
        </p>
        <form onSubmit={createOrder}>
          <label>
            Store reference
            <input name="storeRef" required defaultValue="BUFFALO" />
          </label>
          <label>
            Store display name
            <input name="storeName" defaultValue="Buffalo Burger" />
          </label>
          <label>
            Bag count
            <input name="bagCount" type="number" min="1" required defaultValue={5} />
          </label>
          <label>
            Floor
            <input name="floor" defaultValue="4th" />
          </label>
          <label>
            Zone
            <input name="zone" defaultValue="C" />
          </label>
          <label>
            Address
            <input name="address" defaultValue="Mirdif City Centre, Level 1 - Sheikh Zayed Rd - Dubai" />
          </label>
          <label className="checkbox-row">
            <input name="fragile" type="checkbox" />
            Fragile items
          </label>
          <button type="submit">Create order</button>
        </form>
        <p className="hint">
          Store display name and Fragile items require the optional
          <code> 0005_order_fragile.sql </code> migration.
        </p>
      </section>

      <section>
        <h2>Create pigeon holes</h2>
        <form onSubmit={createHoles}>
          <label>
            Sort wall
            <select name="sortWallId" required>
              {sortWalls.map((sw) => (
                <option key={sw.id} value={sw.id}>
                  {sw.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Count
            <input name="count" type="number" min="1" required defaultValue={10} />
          </label>
          <label>
            Prefix
            <input name="prefix" defaultValue="P" />
          </label>
          <button type="submit">Create holes</button>
        </form>
      </section>

      <section>
        <h2>Create warehouse gate code</h2>
        <form onSubmit={createGate}>
          <label>
            Warehouse
            <select name="warehouseId" required>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Create gate code</button>
        </form>
      </section>

      <p className="hint">
        Warehouses and sort walls themselves are created directly via SQL (see
        supabase/seed.sql) since that only happens rarely — see app/README.md.
      </p>
    </div>
  );
}
