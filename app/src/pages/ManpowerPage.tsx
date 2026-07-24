import { useEffect, useState, type FormEvent } from 'react';
import { humanizePickerCreateError, validatePickerCreateInput } from '../lib/pickerAuth';
import { supabase } from '../lib/supabaseClient';
import { StatusPill } from '../components/StatusPill';
import { pickerStatusMeta, orderStatusMeta } from '../lib/status';
import { useToast } from '../lib/useToast';

// Order the live-order pipeline reads left-to-right on the stats board.
const ORDER_PIPELINE: string[] = [
  'available',
  'assigned',
  'picking_in_progress',
  'picked',
  'arrived_at_warehouse',
  'sorting_in_progress',
  'dispatched',
];
const LIVE_STATUSES = new Set([
  'available',
  'assigned',
  'picking_in_progress',
  'picked',
  'in_transit_to_warehouse',
  'arrived_at_warehouse',
  'sorting_in_progress',
  'ready_for_dispatch',
]);

interface PickerRosterRow {
  id: string;
  picker_code_masked: string | null;
  full_name: string | null;
  phone_masked: string | null;
  home_zone: string | null;
  all_zones: boolean;
  status: 'active' | 'suspended' | 'offboarded';
  is_online: boolean;
  active_orders: number;
}

interface CreatedPicker {
  id: string;
  picker_code: string;
  phone_e164: string;
  full_name: string;
  home_zone: string | null;
  all_zones: boolean;
  login_code: string;
}

export function ManpowerPage() {
  const [pickers, setPickers] = useState<PickerRosterRow[]>([]);
  const [zones, setZones] = useState<{ code: string; label: string }[]>([]);
  const [orderStatuses, setOrderStatuses] = useState<string[]>([]);
  const { toast, notify } = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPicker | null>(null);
  const [allZones, setAllZones] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Let the one-time credentials dialog close on Escape.
  useEffect(() => {
    if (!created) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCreated(null);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [created]);

  const copyField = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label} copied.`, 'success');
    } catch {
      notify(`Could not copy ${label}.`, 'error');
    }
  };

  const load = async () => {
    const [roster, zoneRows, orderRows] = await Promise.all([
      supabase.rpc('admin_list_pickers_v1'),
      supabase.from('zones').select('code, label').eq('is_active', true).order('sort_order'),
      supabase.from('orders').select('status'),
    ]);
    if (roster.error) notify(`Could not load picker roster: ${humanizePickerCreateError(roster.error.message)}`, 'error');
    else setPickers((roster.data as PickerRosterRow[] | null) ?? []);
    setZones((zoneRows.data as { code: string; label: string }[] | null) ?? []);
    setOrderStatuses(((orderRows.data as { status: string }[] | null) ?? []).map((o) => o.status));
  };

  // Load once on mount. `load` is a stable per-render closure over supabase
  // only; re-running on its identity would just refetch needlessly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
  }, []);

  const createPicker = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fullName = String(new FormData(form).get('name') ?? '');
    const phone = String(new FormData(form).get('phone') ?? '');
    const loginCode = String(new FormData(form).get('loginCode') ?? '');
    const zone = String(new FormData(form).get('zone') ?? '');

    const localError = validatePickerCreateInput({
      fullName,
      phone,
      loginCode,
      zone,
      allZones,
    });
    if (localError) {
      setFormError(localError);
      return;
    }

    if (!allZones && zones.length > 0 && !zones.some((row) => row.code === zone.trim().toUpperCase())) {
      setFormError(`Zone “${zone.trim()}” is not in the active zone list. Pick one of the suggested zones, or tick All Zones.`);
      return;
    }

    setFormError(null);
    setSubmitting(true);
    const { data, error } = await supabase.rpc('admin_create_picker_v1', {
      p_full_name: fullName,
      p_phone: phone,
      p_login_code: loginCode,
      p_zone: allZones ? null : zone,
      p_all_zones: allZones,
    });
    setSubmitting(false);

    if (error) {
      const message = humanizePickerCreateError(error.message);
      setFormError(message);
      notify(`Could not create picker: ${message}`, 'error');
      return;
    }

    setCreated(data as CreatedPicker);
    form.reset();
    setAllZones(false);
    void load();
  };

  const STATUS_DONE: Record<'active' | 'suspended' | 'offboarded', string> = {
    active: 'Picker reactivated.',
    suspended: 'Picker suspended.',
    offboarded: 'Picker offboarded.',
  };

  const updatePicker = async (picker: PickerRosterRow, status: 'active' | 'suspended' | 'offboarded') => {
    // Guard destructive transitions behind a confirm. Offboarding is terminal.
    if (status === 'suspended' && !window.confirm(`Suspend ${picker.full_name ?? 'this picker'}? They will be signed out and stop receiving orders until reactivated.`)) {
      return;
    }
    if (status === 'offboarded' && !window.confirm(`Offboard ${picker.full_name ?? 'this picker'}? This is permanent - they cannot be reactivated from here.`)) {
      return;
    }
    const { error } = await supabase.rpc('admin_update_picker_profile_v1', {
      p_picker_id: picker.id,
      p_full_name: picker.full_name ?? '',
      p_home_zone: picker.home_zone,
      p_all_zones: picker.all_zones,
      p_status: status,
    });
    if (error) notify(`Could not update picker: ${humanizePickerCreateError(error.message)}`, 'error');
    else {
      notify(STATUS_DONE[status], 'success');
      void load();
    }
  };

  const totalPickers = pickers.length;
  // A suspended/offboarded picker is never counted as online.
  const onlinePickers = pickers.filter((p) => p.is_online && p.status === 'active').length;
  const totalLiveOrders = orderStatuses.filter((s) => LIVE_STATUSES.has(s)).length;
  const statusCounts = orderStatuses.reduce<Record<string, number>>((acc, s) => {
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="admin-screen manpower-screen">
      {toast && <div className={`toast is-${toast.variant}`} role="alert">{toast.text}</div>}
      <header className="panel-heading">
        <div>
          <span className="panel-eyebrow">Operations roster</span>
          <h1>Manpower</h1>
          <p>Create pickers, assign their zone coverage, and manage their operational access.</p>
        </div>
      </header>

      <section className="ops-stats">
        <div className="stat-tiles">
          <div className="stat-tile">
            <span className="stat-value">{totalPickers}</span>
            <span className="stat-label">Total pickers</span>
          </div>
          <div className="stat-tile">
            <span className="stat-value stat-online">{onlinePickers}</span>
            <span className="stat-label">Online now</span>
          </div>
          <div className="stat-tile">
            <span className="stat-value">{totalLiveOrders}</span>
            <span className="stat-label">Live orders</span>
          </div>
        </div>
        <div className="stat-pipeline">
          {ORDER_PIPELINE.map((status) => (
            <span key={status} className={`state-pill tone-${orderStatusMeta(status).tone}`}>
              {orderStatusMeta(status).label}: <strong>{statusCounts[status] ?? 0}</strong>
            </span>
          ))}
        </div>
      </section>

      <section>
        <h2>Add picker</h2>
        <form onSubmit={createPicker} noValidate>
          <label>
            Name
            <input name="name" required minLength={2} autoComplete="name" placeholder="Picker full name" />
          </label>
          <label>
            Mobile number
            <input name="phone" inputMode="tel" placeholder="0501234567 or +971501234567" required />
            <small className="field-hint">UAE local (05…) or full international with country code.</small>
          </label>
          <label>
            Login code
            <input name="loginCode" inputMode="numeric" pattern="[0-9]{6,8}" placeholder="6–8 digits" required />
            <small className="field-hint">Digits only — this is the picker&apos;s password at login.</small>
          </label>
          <label>
            Zone
            <input name="zone" list="zones" disabled={allZones} required={!allZones} placeholder={zones[0]?.code ?? 'e.g. C'} />
            <datalist id="zones">
              {zones.map((zone) => <option key={zone.code} value={zone.code}>{zone.label}</option>)}
            </datalist>
            <small className="field-hint">
              {allZones
                ? 'All Zones selected — this picker can take orders from any zone.'
                : zones.length > 0
                  ? 'Pick a suggested zone code, or tick All Zones.'
                  : 'No zones configured yet — type a zone code (e.g. C), or tick All Zones.'}
            </small>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={allZones} onChange={(event) => setAllZones(event.target.checked)} />
            All Zones
          </label>
          {formError && <p className="error-text" role="alert">{formError}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create picker'}
          </button>
        </form>
      </section>

      <section className="manpower-roster">
        <div className="roster-head">
          <h2>Picker roster</h2>
          <span className="roster-count">{pickers.length} picker{pickers.length === 1 ? '' : 's'}</span>
        </div>
        {pickers.length === 0 ? (
          <p className="empty-state">No pickers created yet.</p>
        ) : (
          <div className="roster-table-wrap">
            <table className="roster-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Zone</th>
                  <th>Status</th>
                  <th>Presence</th>
                  <th className="num">Active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pickers.map((picker) => (
                  <tr key={picker.id}>
                    <td className="mono">{picker.picker_code_masked ?? 'PKR-••••'}</td>
                    <td>{picker.full_name ?? 'Unnamed picker'}</td>
                    <td className="mono">{picker.phone_masked ?? '—'}</td>
                    <td>{picker.all_zones ? 'All zones' : picker.home_zone ?? '—'}</td>
                    <td><StatusPill meta={pickerStatusMeta(picker.status)} /></td>
                    <td>
                      {(() => {
                        // Suspended/offboarded pickers are always shown offline.
                        const online = picker.is_online && picker.status === 'active';
                        return (
                          <span className={`roster-online ${online ? 'is-online' : ''}`}>
                            {online ? '● Online' : '○ Offline'}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="num">{picker.active_orders}</td>
                    <td>
                      <div className="roster-actions">
                        {picker.status === 'active' && (
                          <button type="button" className="secondary-button" onClick={() => void updatePicker(picker, 'suspended')}>
                            Suspend
                          </button>
                        )}
                        {picker.status === 'suspended' && (
                          <button type="button" className="secondary-button" onClick={() => void updatePicker(picker, 'active')}>
                            Reactivate
                          </button>
                        )}
                        {picker.status !== 'offboarded' ? (
                          <button type="button" className="danger-button" onClick={() => void updatePicker(picker, 'offboarded')}>
                            Offboard
                          </button>
                        ) : (
                          <span className="roster-terminal">Offboarded</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {created && (
        <div className="qr-dialog-backdrop" role="presentation">
          <section className="qr-dialog manpower-created" role="dialog" aria-modal="true">
            <h2>Picker created</h2>
            <p>Give these credentials to the picker now. The picker ID and login code are only shown here, once.</p>
            <ul className="cred-list">
              <li>
                <span><small>Picker ID</small><strong>{created.picker_code}</strong></span>
                <button type="button" className="secondary-button" onClick={() => void copyField('Picker ID', created.picker_code)}>Copy</button>
              </li>
              <li>
                <span><small>Mobile</small><strong>{created.phone_e164}</strong></span>
                <button type="button" className="secondary-button" onClick={() => void copyField('Mobile', created.phone_e164)}>Copy</button>
              </li>
              <li>
                <span><small>Login code</small><strong>{created.login_code}</strong></span>
                <button type="button" className="secondary-button" onClick={() => void copyField('Login code', created.login_code)}>Copy</button>
              </li>
            </ul>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void copyField('All credentials', `Picker ID: ${created.picker_code}\nMobile: ${created.phone_e164}\nLogin code: ${created.login_code}`)}
            >
              Copy all
            </button>
            <button type="button" onClick={() => setCreated(null)}>I have saved these credentials</button>
          </section>
        </div>
      )}
    </div>
  );
}
