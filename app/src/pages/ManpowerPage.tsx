import { useEffect, useState, type FormEvent } from 'react';
import { humanizePickerCreateError, validatePickerCreateInput } from '../lib/pickerAuth';
import { supabase } from '../lib/supabaseClient';

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
  const [toast, setToast] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPicker | null>(null);
  const [allZones, setAllZones] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 6000);
  };

  const load = async () => {
    const [roster, zoneRows] = await Promise.all([
      supabase.rpc('admin_list_pickers_v1'),
      supabase.from('zones').select('code, label').eq('is_active', true).order('sort_order'),
    ]);
    if (roster.error) notify(`Could not load picker roster: ${humanizePickerCreateError(roster.error.message)}`);
    else setPickers((roster.data as PickerRosterRow[] | null) ?? []);
    setZones((zoneRows.data as { code: string; label: string }[] | null) ?? []);
  };

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
      notify(`Could not create picker: ${message}`);
      return;
    }

    setCreated(data as CreatedPicker);
    form.reset();
    setAllZones(false);
    void load();
  };

  const updatePicker = async (picker: PickerRosterRow, status: 'active' | 'suspended' | 'offboarded') => {
    const { error } = await supabase.rpc('admin_update_picker_profile_v1', {
      p_picker_id: picker.id,
      p_full_name: picker.full_name ?? '',
      p_home_zone: picker.home_zone,
      p_all_zones: picker.all_zones,
      p_status: status,
    });
    if (error) notify(`Could not update picker: ${humanizePickerCreateError(error.message)}`);
    else {
      notify(status === 'active' ? 'Picker reactivated.' : 'Picker suspended.');
      void load();
    }
  };

  return (
    <div className="admin-screen manpower-screen">
      {toast && <div className="toast">{toast}</div>}
      <header className="panel-heading">
        <div>
          <span className="panel-eyebrow">Operations roster</span>
          <h1>Manpower</h1>
          <p>Create pickers, assign their zone coverage, and manage their operational access.</p>
        </div>
      </header>

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
        <h2>Picker roster</h2>
        {pickers.length === 0 && <p className="empty-state">No pickers created yet.</p>}
        {pickers.map((picker) => (
          <div className="manpower-row" key={picker.id}>
            <div>
              <strong>{picker.picker_code_masked ?? 'PKR-••••'}</strong>
              <span>{picker.full_name ?? 'Unnamed picker'}</span>
              <small>{picker.phone_masked ?? 'Mobile hidden'} · {picker.all_zones ? 'All Zones' : picker.home_zone ?? 'No zone'}</small>
            </div>
            <div>
              <span className={`state-pill ${picker.status === 'active' ? 'state-ready' : 'state-progress'}`}>{picker.status}</span>
              <small>{picker.is_online ? '● Online' : '○ Offline'} · {picker.active_orders} active</small>
            </div>
            <button type="button" onClick={() => void updatePicker(picker, picker.status === 'active' ? 'suspended' : 'active')}>
              {picker.status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
          </div>
        ))}
      </section>

      {created && (
        <div className="qr-dialog-backdrop" role="presentation">
          <section className="qr-dialog manpower-created" role="dialog" aria-modal="true">
            <h2>Picker created</h2>
            <p>Give these credentials to the picker now. The picker ID is intentionally only revealed here.</p>
            <strong>Picker ID: {created.picker_code}</strong>
            <strong>Mobile: {created.phone_e164}</strong>
            <strong>Login code: {created.login_code}</strong>
            <button type="button" onClick={() => setCreated(null)}>I have copied these credentials</button>
          </section>
        </div>
      )}
    </div>
  );
}
