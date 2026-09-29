/* ========================================================================
   SI-LPD — Sistem Informasi Laporan Perjalanan Dinas & Dokumentasi Kegiatan
   Backend: Supabase (Auth + Postgres + Storage). Hosting: Firebase Hosting
   (atau hosting statis apa pun — file ini murni client-side).
   ======================================================================== */

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const BUCKET = window.SUPABASE_BUCKET || 'si-lpd-files';

let ME = {id:null, name:'', email:'', isAdmin:false};
let SETTINGS = null;
let SERIES = [];              // seri penomoran (jenis kegiatan/bidang)
let LPD_LIST = [];
let ADMIN_PROFILES = [];
let ALL_PROFILES = [];
let ROUTE = 'dashboard';
let DRAFT = null;
let STEP = 0;
let AUTH_MODE = 'login';      // 'login' | 'register'
let lpdChannel=null, settingsChannel=null, seriesChannel=null, profilesChannel=null, officersChannel=null, reportMasterChannel=null;
let OFFICERS=[];
let REPORT_MASTER=[];

const BASE_FIELDS=[
  {key:'sasaran',   label:'a. Sasaran'},
  {key:'proses',    label:'b. Proses'},
  {key:'alatBahan', label:'c. Alat dan Bahan'},
  {key:'capaian',   label:'d. Capaian Kinerja'},
  {key:'lintasProgram', label:'e. Peran Lintas Program'},
  {key:'lintasSektor',  label:'f. Peran Lintas Sektor'},
  {key:'umpanBalik',    label:'g. Umpan Balik'},
];
const REPORT_MASTER_FIELDS=[
  ...BASE_FIELDS,
  {key:'masalah', label:'h. Masalah'},
  {key:'rekomendasi', label:'i. Rekomendasi'},
];
const PAPER_PRESETS={ A4:{w:21.0,h:29.7}, F4:{w:21.5,h:33.0}, Legal:{w:21.59,h:35.56}, Letter:{w:21.59,h:27.94} };

function DEFAULT_SETTINGS(){
  return {
    kop:{ baris1:'PEMERINTAH KABUPATEN ...', baris2:'DINAS KESEHATAN ...', baris3:'',
      puskesmas:'PUSKESMAS ...', alamat:'', email:'', logoUrl:'', kotaSurat:'Sumenep' },
    paper:{preset:'Custom', widthCm:21, heightCm:33, marginTopCm:2, marginBottomCm:2, marginLeftCm:2, marginRightCm:2},
    pjOptions:[{id:'pj1', jabatan:'PJ UKM Esensial', name:'', nip:''}],
    defaultPjId:'pj1',
    kepala:{jabatan:'Plt. Kepala Puskesmas', name:'', nip:'', stampUrl:'', stampWidthCm:2.8, stampOffsetXCm:-1.6, stampOffsetYCm:-1.2, ttdUrl:'', ttdWidthCm:3.2},
    officerColumns:2,
    baseFields:{sasaran:true,proses:true,alatBahan:true,capaian:true,lintasProgram:true,lintasSektor:true,umpanBalik:true},
    extraFields:[],
    photoCols:3, photoMax:9,
    wilayah:[], // [{id, desa, dusun:[{id, nama, rtList:['01','02',...]}]}] — diisi admin di Pengaturan
    typography:{
      judul:{sizePt:12, bold:true},
      kop:{sizePt:12, bold:false},
      isiTabel:{sizePt:12, bold:false},
      tandaTangan:{sizePt:12, bold:false},
      dokumentasi:{sizePt:12, bold:false}
    }
  };
}
function emptyDraft(){
  return {
    id:null, status:'draft',
    createdBy:ME.id, createdByName:ME.name, createdAt:null, updatedAt:null,
    seriesId: (SERIES.find(s=>s.isDefault)||SERIES[0]||{}).id || null,
    sptNumber:'', spdNumber:'', sptManual:false, spdManual:false,
    kegiatan:'', tanggal:'', hari:'',
    officers:[{name:'',nip:''}],
    desaId:'', dusunId:'', rt:'', lokasi:'',
    fields:{sasaran:'',proses:'',alatBahan:'',capaian:'',lintasProgram:'',lintasSektor:'',umpanBalik:''},
    extraFieldValues:{},
    masalah:'', rekomendasi:'',
    reportTemplateId:null,
    pjId:(SETTINGS && SETTINGS.defaultPjId)||'pj1',
    photos:[],
    collage:{template:'auto', ratio:'1:1', gap:8}
  };
}

/* ---------------------------- row <-> app mapping ---------------------------- */
function normalizeWilayahCsv(wilayah){
  // Database lama bisa menyimpan beberapa Desa/Dusun dalam satu string dipisahkan koma.
  // Pecah menjadi option terpisah agar dropdown benar-benar satu pilihan per wilayah.
  if(!Array.isArray(wilayah)) return [];
  const out=[];
  wilayah.forEach((rawDi, di)=>{
    const desaNames=String(rawDi?.desa||'').split(',').map(x=>x.trim()).filter(Boolean);
    const baseDusun=Array.isArray(rawDi?.dusun)?rawDi.dusun:[];
    const dusunNorm=[];
    baseDusun.forEach((rawDu, ui)=>{
      const names=String(rawDu?.nama||'').split(',').map(x=>x.trim()).filter(Boolean);
      const rtRaw=Array.isArray(rawDu?.rtList) ? rawDu.rtList : String(rawDu?.rtList||'').split(',');
      const rtList=rtRaw.map(x=>String(x).trim()).filter(Boolean);
      if(names.length){
        names.forEach((name, j)=>dusunNorm.push({
          id: rawDu.id && j===0 ? rawDu.id : `du_norm_${di}_${ui}_${j}`,
          nama:name, rtList:[...rtList]
        }));
      }
    });
    if(desaNames.length){
      desaNames.forEach((desa,j)=>out.push({
        id: rawDi.id && j===0 ? rawDi.id : `ds_norm_${di}_${j}`,
        desa,
        dusun:JSON.parse(JSON.stringify(dusunNorm))
      }));
    }
  });
  return out;
}

function settingsFromRow(r){
  const base=DEFAULT_SETTINGS();
  const merged=deepMerge(base, {
    kop:r.kop, paper:r.paper, kepala:r.kepala, pjOptions:r.pj_options, defaultPjId:r.default_pj_id,
    officerColumns:r.officer_columns, baseFields:r.base_fields, extraFields:r.extra_fields,
    photoMax:r.photo_max, photoCols:r.photo_cols, wilayah:normalizeWilayahCsv(r.wilayah), typography:r.typography, updatedAt:r.updated_at, updatedBy:r.updated_by
  });
  // Selalu sediakan satu PJ UKM Esensial. Jika database lama belum memiliki
  // data PJ, gunakan data dari format Word contoh sebagai nilai awal.
  if(!Array.isArray(merged.pjOptions) || !merged.pjOptions.length){
    merged.pjOptions=[{id:'pj1',jabatan:'PJ UKM Esensial',name:'Melly Dwi Kartika, A.Md. Keb',nip:'19880527 201001 2 010'}];
    merged.defaultPjId='pj1';
  } else {
    merged.pjOptions=merged.pjOptions.map((x,i)=>({id:x.id||('pj'+(i+1)),jabatan:x.jabatan||'PJ UKM Esensial',name:x.name||'',nip:x.nip||''}));
    if(!merged.pjOptions.some(x=>x.id===merged.defaultPjId)) merged.defaultPjId=merged.pjOptions[0].id;
  }
  return merged;
}
function settingsToRow(s){
  return { id:1, kop:s.kop, paper:s.paper, kepala:s.kepala, pj_options:s.pjOptions, default_pj_id:s.defaultPjId,
    officer_columns:s.officerColumns, base_fields:s.baseFields, extra_fields:s.extraFields,
    photo_max:s.photoMax, photo_cols:s.photoCols, wilayah:s.wilayah||[], typography:s.typography||{}, updated_at:new Date().toISOString(), updated_by:ME.name };
}
function seriesFromRow(r){
  return {id:r.id, name:r.name, sptFormat:r.spt_format, sptCounter:r.spt_counter, spdFormat:r.spd_format, spdCounter:r.spd_counter, isDefault:r.is_default};
}
function lpdFromRow(r){
  return {
    id:r.id, createdBy:r.created_by, createdByName:r.created_by_name, status:r.status,
    seriesId:r.series_id, seriesName:r.series_name,
    sptNumber:r.spt_number, spdNumber:r.spd_number, sptManual:r.spt_manual, spdManual:r.spd_manual,
    hari:r.hari, tanggal:r.tanggal, kegiatan:r.kegiatan, lokasi:r.lokasi,
    desaId:r.desa_id||'', dusunId:r.dusun_id||'', rt:r.rt||'',
    officers:r.officers||[], fields:r.fields||{}, extraFieldValues:r.extra_field_values||{},
    masalah:r.masalah, rekomendasi:r.rekomendasi, reportTemplateId:r.report_template_id||null,
    pjId:r.pj_id, photos:r.photos||[], collage:r.collage||{template:'auto',ratio:'1:1',gap:8},
    createdAt:r.created_at, updatedAt:r.updated_at
  };
}
function lpdToRow(d){
  return {
    created_by:d.createdBy, created_by_name:d.createdByName, status:d.status,
    series_id:d.seriesId, series_name:d.seriesName,
    spt_number:d.sptNumber, spd_number:d.spdNumber, spt_manual:!!d.sptManual, spd_manual:!!d.spdManual,
    hari:d.hari, tanggal:d.tanggal||null, kegiatan:d.kegiatan, lokasi:d.lokasi,
    desa_id:d.desaId||null, dusun_id:d.dusunId||null, rt:d.rt||null,
    officers:d.officers, fields:d.fields, extra_field_values:d.extraFieldValues,
    masalah:d.masalah, rekomendasi:d.rekomendasi, report_template_id:d.reportTemplateId||null,
    pj_id:d.pjId, photos:d.photos, collage:d.collage||{template:'auto',ratio:'1:1',gap:8},
    updated_at:new Date().toISOString()
  };
}
function deepMerge(base,over){
  const out=Array.isArray(base)?[...base]:{...base};
  for(const k in (over||{})){
    if(over[k]&&typeof over[k]==='object'&&!Array.isArray(over[k])&&base[k]&&typeof base[k]==='object'){ out[k]=deepMerge(base[k],over[k]); }
    else if(over[k]!==undefined) out[k]=over[k];
  }
  return out;
}

function pathFromStoredUrl(url){
  if(!url) return '';
  const marker='/storage/v1/object/public/'+BUCKET+'/';
  const i=url.indexOf(marker);
  return i>=0 ? decodeURIComponent(url.slice(i+marker.length).split('?')[0]) : '';
}
async function signedUrl(path, expiresIn=3600){
  if(!path) return '';
  const {data,error}=await sb.storage.from(BUCKET).createSignedUrl(path, expiresIn);
  return error ? '' : (data?.signedUrl||'');
}
async function hydrateMedia(){
  // URL publik lama tetap diterima; file baru menggunakan signed URL.
  if(SETTINGS){
    const k=SETTINGS.kop||{}, h=SETTINGS.kepala||{};
    k.logoPath = k.logoPath || pathFromStoredUrl(k.logoUrl);
    h.stampPath = h.stampPath || pathFromStoredUrl(h.stampUrl);
    h.ttdPath = h.ttdPath || pathFromStoredUrl(h.ttdUrl);
    if(k.logoPath) k.logoUrl=await signedUrl(k.logoPath);
    if(h.stampPath) h.stampUrl=await signedUrl(h.stampPath);
    if(h.ttdPath) h.ttdUrl=await signedUrl(h.ttdPath);
  }
  for(const item of LPD_LIST){
    for(const photo of (item.photos||[])){
      if(photo.path){ const u=await signedUrl(photo.path); if(u) photo.url=u; }
    }
  }
  if(DRAFT){
    for(const photo of (DRAFT.photos||[])){
      if(photo.path){ const u=await signedUrl(photo.path); if(u) photo.url=u; }
    }
  }
}

/* ---------------------------- boot / auth ---------------------------- */
async function boot(){
  const {data:{session}} = await sb.auth.getSession();
  if(session) await onLoggedIn(session);
  else renderAuthScreen();

  sb.auth.onAuthStateChange(async (event, session)=>{
    if(event==='SIGNED_IN' && session){ await onLoggedIn(session); }
    else if(event==='SIGNED_OUT'){ teardownSubscriptions(); ME={id:null,name:'',email:'',isAdmin:false}; renderAuthScreen(); }
  });
  window.addEventListener('hashchange', onHashChange);
}

async function onLoggedIn(session){
  ME.id = session.user.id; ME.email = session.user.email;
  let {data:prof,error:profError} = await sb.from('profiles').select('*').eq('id', ME.id).maybeSingle();
  // Trigger seharusnya membuat profile otomatis. Jika profile belum tersedia,
  // jangan diam-diam menganggap user sebagai non-admin; tampilkan petunjuk yang jelas.
  if(profError){
    console.error('[SI-LPD] Gagal membaca profiles:', profError);
    alert('Login berhasil, tetapi profil pengguna belum dapat dibaca. Jalankan schema_security_patch.sql di Supabase.');
  }
  ME.name = (prof && prof.full_name) || ME.email;
  ME.isAdmin = !!(prof && prof.is_admin);

  document.getElementById('topbar').style.display='flex';
  await Promise.all([loadSettings(), loadSeries(), loadProfiles(), loadOfficers(), loadReportMaster()]);
  subscribeLpd(); subscribeSettings(); subscribeSeries(); subscribeProfiles(); subscribeOfficers(); subscribeReportMaster();
  onHashChange();
}

async function signOut(){ await sb.auth.signOut(); }

function renderAuthScreen(){
  document.getElementById('topbar').style.display='none';
  const app=document.getElementById('app');
  app.innerHTML=`
    <div style="max-width:400px;margin:60px auto" class="card">
      <h2 style="text-align:center">📋 SI-LPD Puskesmas</h2>
      <div class="muted small" style="text-align:center;margin-bottom:16px">Sistem Laporan Perjalanan Dinas & Dokumentasi Kegiatan</div>
      <div class="stepper" style="justify-content:center">
        <button class="step-btn ${AUTH_MODE==='login'?'current':''}" onclick="AUTH_MODE='login';renderAuthScreen()">Masuk</button>
        <button class="step-btn ${AUTH_MODE==='register'?'current':''}" onclick="AUTH_MODE='register';renderAuthScreen()">Daftar Akun</button>
      </div>
      ${AUTH_MODE==='register'?`<label>Nama Lengkap</label><input type="text" id="auth-name" placeholder="Nama Anda">`:''}
      <label>Email</label><input type="text" id="auth-email" placeholder="nama@instansi.go.id">
      <label>Password</label><input type="text" id="auth-pass" placeholder="Minimal 6 karakter" style="-webkit-text-security:disc">
      <div id="auth-error" style="color:#c0392b;font-size:12.5px;margin-top:8px"></div>
      <button class="btn btn-primary" style="width:100%;margin-top:14px;justify-content:center"
        onclick="${AUTH_MODE==='login'?'doLogin()':'doRegister()'}">${AUTH_MODE==='login'?'Masuk':'Daftar & Masuk'}</button>
      ${AUTH_MODE==='register'?`<div class="hint" style="margin-top:10px">Pengguna pertama yang mendaftar otomatis menjadi admin aplikasi.</div>`:''}
    </div>`;
}
async function doLogin(){
  const email=document.getElementById('auth-email').value.trim();
  const password=document.getElementById('auth-pass').value;
  const {error} = await sb.auth.signInWithPassword({email,password});
  if(error) document.getElementById('auth-error').textContent = error.message;
}
async function doRegister(){
  const full_name=document.getElementById('auth-name').value.trim();
  const email=document.getElementById('auth-email').value.trim();
  const password=document.getElementById('auth-pass').value;
  if(password.length<6){ document.getElementById('auth-error').textContent='Password minimal 6 karakter.'; return; }
  const {error} = await sb.auth.signUp({email,password, options:{data:{full_name}}});
  if(error) document.getElementById('auth-error').textContent = error.message;
  else document.getElementById('auth-error').style.color='#1e824c',
       document.getElementById('auth-error').textContent='Berhasil daftar. Jika verifikasi email aktif di project Anda, cek inbox lalu login.';
}

function teardownSubscriptions(){
  [lpdChannel,settingsChannel,seriesChannel,profilesChannel,officersChannel,reportMasterChannel].forEach(c=>c&&sb.removeChannel(c));
}

/* ---------------------------- routing ---------------------------- */
function onHashChange(){
  const h=location.hash.replace('#/','')||'dashboard';
  const parts=h.split('/');
  ROUTE=parts[0];
  if(ROUTE==='edit'&&parts[1]) openEditor(parts[1]);
  else if(ROUTE==='new'){ DRAFT=emptyDraft(); STEP=0; render(); }
  else render();
  window.scrollTo(0,0);
}
function go(route){ location.hash='#/'+route; }
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(window._toastT); window._toastT=setTimeout(()=>t.classList.remove('show'),2600);
}

/* ---------------------------- data loaders ---------------------------- */
async function loadSettings(){
  const {data,error} = await sb.from('settings').select('*').eq('id',1).single();
  SETTINGS = data ? settingsFromRow(data) : DEFAULT_SETTINGS();
  await hydrateMedia();
}
function subscribeSettings(){
  settingsChannel = sb.channel('settings-ch').on('postgres_changes',{event:'*',schema:'public',table:'settings'},
    async payload=>{ SETTINGS = settingsFromRow(payload.new); await hydrateMedia(); if(ROUTE!=='new'&&ROUTE!=='edit') render(); }).subscribe();
}
async function loadSeries(){
  const {data} = await sb.from('numbering_series').select('*').order('name');
  SERIES = (data||[]).map(seriesFromRow);
}
function subscribeSeries(){
  seriesChannel = sb.channel('series-ch').on('postgres_changes',{event:'*',schema:'public',table:'numbering_series'},
    async ()=>{ await loadSeries(); if(ROUTE==='settings') render(); }).subscribe();
}
async function loadProfiles(){
  const {data} = await sb.from('profiles').select('*').order('full_name');
  ALL_PROFILES = data||[];
  ADMIN_PROFILES = ALL_PROFILES.filter(p=>p.is_admin);
}
function subscribeProfiles(){
  profilesChannel = sb.channel('profiles-ch').on('postgres_changes',{event:'*',schema:'public',table:'profiles'},
    async ()=>{ await loadProfiles(); const {data:prof}=await sb.from('profiles').select('*').eq('id',ME.id).single();
      if(prof){ ME.isAdmin=!!prof.is_admin; ME.name=prof.full_name||ME.email; }
      renderTopbarUser(); if(ROUTE==='users') render(); }).subscribe();
}
async function loadOfficers(){
  const {data,error}=await sb.from('pelaksana_kegiatan').select('id,nama,nip_nik').order('nama');
  if(error){
    console.error('[SI-LPD] Gagal membaca pelaksana_kegiatan:', error);
    OFFICERS=[];
    toast('Data petugas belum dapat dimuat: '+error.message);
    return;
  }
  OFFICERS=(data||[]).map(p=>({id:p.id,name:p.nama||'',nip:p.nip_nik||''}));
}
function subscribeOfficers(){
  officersChannel = sb.channel('officers-ch').on('postgres_changes',{event:'*',schema:'public',table:'pelaksana_kegiatan'},
    async ()=>{ await loadOfficers(); if(ROUTE==='new'||ROUTE==='edit') render(); }).subscribe();
}
async function loadReportMaster(){
  const {data,error}=await sb.from('laporan_kegiatan')
    .select('Id,sasaran,proses,alat_bahan,capaian,lintas_program,lintas_sektor,umpan_balik,masalah,rekomendasi')
    .order('Id',{ascending:false});
  if(error){
    console.warn('[SI-LPD] Template laporan belum tersedia:', error.message);
    REPORT_MASTER=[];
    return;
  }
  REPORT_MASTER=(data||[]).map(r=>({
    id:r.Id,
    sasaran:r.sasaran||'',
    proses:r.proses||'',
    alatBahan:r.alat_bahan||'',
    capaian:r.capaian||'',
    lintasProgram:r.lintas_program||'',
    lintasSektor:r.lintas_sektor||'',
    umpanBalik:r.umpan_balik||'',
    masalah:r.masalah||'',
    rekomendasi:r.rekomendasi||''
  }));
}
function subscribeReportMaster(){
  reportMasterChannel = sb.channel('report-master-ch').on(
    'postgres_changes',
    {event:'*',schema:'public',table:'laporan_kegiatan'},
    async ()=>{ await loadReportMaster(); if(ROUTE==='new'||ROUTE==='edit') render(); }
  ).subscribe();
}
function applyReportTemplate(id){
  const item=REPORT_MASTER.find(x=>String(x.id)===String(id));
  if(!item) return;
  DRAFT.reportTemplateId=item.id;
  DRAFT.fields.sasaran=item.sasaran;
  DRAFT.fields.proses=item.proses;
  DRAFT.fields.alatBahan=item.alatBahan;
  DRAFT.fields.capaian=item.capaian;
  DRAFT.fields.lintasProgram=item.lintasProgram;
  DRAFT.fields.lintasSektor=item.lintasSektor;
  DRAFT.fields.umpanBalik=item.umpanBalik;
  DRAFT.masalah=item.masalah;
  DRAFT.rekomendasi=item.rekomendasi;
  render();
}
function reportValue(key){
  if(key==='masalah') return DRAFT.masalah||'';
  if(key==='rekomendasi') return DRAFT.rekomendasi||'';
  return DRAFT.fields[key]||'';
}
function setReportValue(key,value){
  if(key==='masalah') DRAFT.masalah=value;
  else if(key==='rekomendasi') DRAFT.rekomendasi=value;
  else DRAFT.fields[key]=value;
}

function setOfficer(i, id){
  const p=OFFICERS.find(x=>String(x.id)===String(id));
  if(!DRAFT.officers[i]) DRAFT.officers[i]={name:'',nip:''};
  DRAFT.officers[i].name=p?.name||'';
  DRAFT.officers[i].nip=p?.nip||'';
  render();
}
function subscribeLpd(){
  refreshLpd();
  lpdChannel = sb.channel('lpd-ch').on('postgres_changes',{event:'*',schema:'public',table:'lpd'}, ()=>refreshLpd()).subscribe();
}
async function refreshLpd(){
  const {data} = await sb.from('lpd').select('*').order('created_at',{ascending:false});
  LPD_LIST = (data||[]).map(lpdFromRow);
  await hydrateMedia();
  if(ROUTE==='dashboard') render();
}

/* ---------------------------- admin management ---------------------------- */
async function setAdmin(userId, val){
  if(!ME.isAdmin) return;
  const {error} = await sb.rpc('set_user_admin',{p_user_id:userId,p_is_admin:val});
  if(error) toast('Gagal: '+error.message); else toast(val?'Dijadikan admin.':'Admin dicabut.');
}

/* ---------------------------- settings save ---------------------------- */
async function saveSettings(s){
  if(!ME.isAdmin){ toast('Hanya admin yang bisa mengubah pengaturan.'); return; }
  const {error} = await sb.from('settings').update(settingsToRow(s)).eq('id',1);
  if(error){ toast('Gagal simpan: '+error.message); return; }
  SETTINGS=s;
  window._settingsDraft=null;
  toast('Pengaturan disimpan.');
}
async function addSeries(){
  const {data,error} = await sb.from('numbering_series').insert({name:'Seri Baru'}).select().single();
  if(error) toast('Gagal: '+error.message); else { await loadSeries(); render(); }
}
async function updateSeries(id, patch){
  const {error} = await sb.from('numbering_series').update(patch).eq('id',id);
  if(error) toast('Gagal: '+error.message);
}
async function deleteSeries(id){
  if(SERIES.length<=1){ toast('Minimal harus ada 1 seri penomoran.'); return; }
  if(!confirm('Hapus seri penomoran ini?')) return;
  await sb.from('numbering_series').delete().eq('id',id);
  await loadSeries(); render();
}
async function setDefaultSeries(id){
  await sb.from('numbering_series').update({is_default:false}).neq('id',id);
  await sb.from('numbering_series').update({is_default:true}).eq('id',id);
  await loadSeries(); render();
}

/* ---------------------------- lpd crud ---------------------------- */
async function persistDraft(status){
  DRAFT.status=status;
  const isNew=!DRAFT.id;
  if(isNew){
    if(!DRAFT.sptManual || !DRAFT.sptNumber){
      const {data,error} = await sb.rpc('next_surat_number',{p_series_id:DRAFT.seriesId, p_kind:'spt'});
      if(error){ toast('Nomor SPT gagal dibuat: '+error.message); return; }
      DRAFT.sptNumber=data;
    }
    if(!DRAFT.spdManual || !DRAFT.spdNumber){
      const {data,error} = await sb.rpc('next_surat_number',{p_series_id:DRAFT.seriesId, p_kind:'spd'});
      if(error){ toast('Nomor SPD gagal dibuat: '+error.message); return; }
      DRAFT.spdNumber=data;
    }
    const s=SERIES.find(x=>x.id===DRAFT.seriesId);
    DRAFT.seriesName = s?s.name:'';
    DRAFT.createdBy=ME.id; DRAFT.createdByName=ME.name;
    const {data,error} = await sb.from('lpd').insert(lpdToRow(DRAFT)).select().single();
    if(error){ toast('Gagal simpan: '+error.message); return; }
    DRAFT.id=data.id;
  } else {
    const {error} = await sb.from('lpd').update(lpdToRow(DRAFT)).eq('id',DRAFT.id);
    if(error){ toast('Gagal simpan: '+error.message); return; }
  }
  toast(status==='final'?'LPD disimpan (final).':'Draft tersimpan.');
  go('dashboard');
}
async function deleteLpd(id){
  if(!confirm('Hapus LPD ini? Tindakan tidak bisa dibatalkan.')) return;
  const {error}=await sb.from('lpd').delete().eq('id',id);
  if(error) toast('Gagal hapus: '+error.message); else toast('LPD dihapus.');
}
function canEditLpd(item){ return ME.isAdmin || item.createdBy===ME.id; }
async function openEditor(id){
  const item=LPD_LIST.find(x=>x.id===id);
  if(!item){ toast('Data tidak ditemukan / masih memuat…'); go('dashboard'); return; }
  DRAFT=JSON.parse(JSON.stringify(item));
  await hydrateMedia();
  if(!DRAFT.officers||!DRAFT.officers.length) DRAFT.officers=[{name:'',nip:''}];
  STEP=0; render();
}

/* ---------------------------- storage (upload) ---------------------------- */
async function pickAndUpload(accept, onDone, options={}){
  const inp=document.createElement('input');
  inp.type='file';
  inp.accept=accept||'image/*';
  inp.multiple=options.multiple!==false;
  inp.onchange=async ()=>{
    const files=Array.from(inp.files||[]);
    if(!files.length) return;
    const max=Number(options.max||SETTINGS?.photoMax||9);
    const limited=files.slice(0,max);
    if(files.length>max) toast(`Maksimal ${max} foto. ${files.length-max} foto dilewati.`);
    toast(`Mengunggah ${limited.length} foto…`);
    const uploaded=[];
    for(let i=0;i<limited.length;i++){
      const f=limited[i];
      const safeName=f.name.replace(/[^a-zA-Z0-9._-]/g,'_');
      const path = `${ME.id}/${Date.now()}_${i}_${safeName}`;
      const {error} = await sb.storage.from(BUCKET).upload(path, f, {upsert:true});
      if(error){ toast(`Gagal unggah ${f.name}: ${error.message}`); continue; }
      const url=await signedUrl(path);
      if(url) uploaded.push({path,url,file:f});
    }
    if(uploaded.length){
      onDone(options.multiResult ? uploaded : uploaded[0]);
      toast(`${uploaded.length} foto berhasil diunggah.`);
    }
  };
  inp.click();
}

/* ============================== RENDER ROOT ============================== */
function render(){
  renderNav(); renderTopbarUser();
  const app=document.getElementById('app');
  if(!SETTINGS){ app.innerHTML='<div class="spinner"></div>'; return; }
  let html='';
  if(ROUTE==='dashboard') html=renderDashboard();
  else if(ROUTE==='new'||ROUTE==='edit') html=renderEditor();
  else if(ROUTE==='preview') html=renderPreviewPage();
  else if(ROUTE==='settings') html=renderSettings();
  else if(ROUTE==='users') html=renderUsers();
  else html=renderDashboard();
  app.innerHTML=html;
}
function renderNav(){
  const el=document.getElementById('navlinks'); if(!el) return;
  const items=[['dashboard','🗂️ Daftar LPD'],['new','+ Buat LPD']];
  if(ME.isAdmin){ items.push(['settings','⚙️ Pengaturan']); items.push(['users','👤 Admin']); }
  el.innerHTML = items.map(([r,l])=>`<button class="${ROUTE===r?'active':''}" onclick="go('${r}')">${l}</button>`).join('')
    + `<button onclick="signOut()">Keluar</button>`;
}
function renderTopbarUser(){
  const el=document.getElementById('userchip-name'); if(!el) return;
  el.innerHTML = escapeHtml(ME.name||'Pengguna') + (ME.isAdmin?' <span class="badge-admin">ADMIN</span>':'');
}

/* ============================== DASHBOARD ============================== */
let DASH_QUERY='';
function renderDashboard(){
  const q=DASH_QUERY.toLowerCase();
  const list=LPD_LIST.filter(it=>{
    if(!q) return true;
    return [(it.kegiatan||''),(it.lokasi||''),(it.createdByName||''),(it.officers||[]).map(o=>o.name).join(' ')]
      .join(' ').toLowerCase().includes(q);
  });
  return `
    <div class="toolbar">
      <div class="searchbox">
        <input type="search" placeholder="Cari kegiatan, petugas, lokasi…" value="${escapeHtml(DASH_QUERY)}"
          oninput="DASH_QUERY=this.value; render()">
      </div>
      <button class="btn btn-primary" onclick="go('new')">+ Buat LPD Baru</button>
    </div>
    <div class="card">
      <h2>Daftar Laporan Perjalanan Dinas</h2>
      <div class="muted small" style="margin-bottom:10px">${list.length} dari ${LPD_LIST.length} laporan</div>
      ${list.length===0?`<div class="empty">Belum ada LPD. Klik <b>+ Buat LPD Baru</b> untuk memulai.</div>`:`
      <div style="overflow-x:auto"><table class="list">
        <thead><tr><th>Kegiatan</th><th>Seri</th><th>Tanggal</th><th>Petugas</th><th>Lokasi</th><th>Status</th><th>Dibuat oleh</th><th></th></tr></thead>
        <tbody>${list.map(it=>`
          <tr>
            <td><b>${escapeHtml(it.kegiatan||'(tanpa judul)')}</b><br><span class="muted small">SPT: ${escapeHtml(it.sptNumber||'-')}</span></td>
            <td><span class="tag">${escapeHtml(it.seriesName||'-')}</span></td>
            <td>${escapeHtml(it.tanggal||'-')}</td>
            <td>${(it.officers||[]).map(o=>escapeHtml(o.name)).filter(Boolean).join(', ')||'-'}</td>
            <td>${escapeHtml(it.lokasi||'-')}</td>
            <td><span class="status-pill ${it.status==='final'?'status-final':'status-draft'}">${it.status==='final'?'Final':'Draft'}</span></td>
            <td>${escapeHtml(it.createdByName||'-')}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-outline btn-sm" onclick="go('preview/${it.id}')">Lihat</button>
              ${canEditLpd(it)?`<button class="btn btn-ghost btn-sm" onclick="go('edit/${it.id}')">Edit</button>`:''}
              <button class="btn btn-primary btn-sm" onclick="downloadWord('${it.id}')">⬇ Word</button>
              ${canEditLpd(it)?`<button class="btn btn-danger btn-sm" onclick="deleteLpd('${it.id}')">Hapus</button>`:''}
            </td>
          </tr>`).join('')}</tbody>
      </table></div>`}
    </div>`;
}

/* ============================== EDITOR (WIZARD) ============================== */
const STEPS=['Dasar & Petugas','Kegiatan','Laporan Kegiatan','Dokumentasi Foto','Review & Simpan'];
function renderEditor(){
  if(!DRAFT) DRAFT=emptyDraft();
  const s=STEP;
  return `
    <div class="card">
      <h2>${DRAFT.id?'Edit':'Buat'} Laporan Perjalanan Dinas</h2>
      <div class="muted small">Kolom yang otomatis terisi (tanggal, nama petugas, tanda tangan pelaksana) akan mengikuti data yang Anda masukkan di sini.</div>
      <div class="stepper" style="margin-top:14px">
        ${STEPS.map((t,i)=>`<button class="step-btn ${i===s?'current':(i<s?'done':'')}" onclick="STEP=${i};render()">${i+1}. ${t}</button>`).join('')}
      </div>
      ${s===0?stepDasar():s===1?stepKegiatan():s===2?stepLaporan():s===3?stepFoto():stepReview()}
      <div class="divider"></div>
      <div class="row" style="justify-content:space-between">
        <div>${s>0?`<button class="btn btn-outline" onclick="STEP=${s-1};render()">← Sebelumnya</button>`:''}</div>
        <div class="row">
          <button class="btn btn-ghost" onclick="saveAndGo('draft')">💾 Simpan Draft</button>
          ${s<STEPS.length-1?`<button class="btn btn-primary" onclick="STEP=${s+1};render()">Lanjut →</button>`
            :`<button class="btn btn-primary" onclick="saveAndGo('final')">✔ Simpan Final</button>`}
        </div>
      </div>
    </div>`;
}
async function saveAndGo(status){ await persistDraft(status); }

function stepDasar(){
  const pjOpts=(SETTINGS.pjOptions||[]);
  return `
    <h3>1. Jenis Kegiatan / Seri Penomoran & Dasar Surat</h3>
    <label>Jenis Kegiatan (menentukan seri nomor SPT/SPD)</label>
    <select onchange="DRAFT.seriesId=this.value">
      ${SERIES.map(s=>`<option value="${s.id}" ${DRAFT.seriesId===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}
    </select>
    <div class="hint">Setiap jenis kegiatan/bidang punya nomor urut SPT & SPD sendiri sehingga tidak akan bentrok. Kelola daftar ini di Pengaturan (khusus admin).</div>
    <div class="grid2" style="margin-top:10px">
      <div>
        <label>Nomor SPT ${DRAFT.id?'':'(otomatis saat disimpan, bisa diubah manual)'}</label>
        <input type="text" value="${escapeHtml(DRAFT.sptNumber)}" placeholder="${DRAFT.sptNumber?'':'otomatis saat disimpan'}"
          oninput="DRAFT.sptNumber=this.value; DRAFT.sptManual=true">
      </div>
      <div>
        <label>Nomor SPD ${DRAFT.id?'':'(otomatis saat disimpan, bisa diubah manual)'}</label>
        <input type="text" value="${escapeHtml(DRAFT.spdNumber)}" placeholder="${DRAFT.spdNumber?'':'otomatis saat disimpan'}"
          oninput="DRAFT.spdNumber=this.value; DRAFT.spdManual=true">
      </div>
    </div>
    <h3>Nama Petugas</h3>
    <div id="officer-list">
      ${DRAFT.officers.map((o,i)=>{
        const selected = OFFICERS.find(p=>p.name===o.name && p.nip===o.nip) || OFFICERS.find(p=>p.name===o.name);
        return `
        <div class="officer-row">
          <div class="col">
            <label>Nama & Gelar</label>
            <select onchange="setOfficer(${i}, this.value)">
              <option value="">-- Pilih Nama & Gelar --</option>
              ${OFFICERS.map(p=>`<option value="${p.id}" ${selected&&String(selected.id)===String(p.id)?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="col">
            <label>NIP / NIK</label>
            <input type="text" value="${escapeHtml(o.nip||'')}" readonly placeholder="Otomatis terisi">
          </div>
          <button class="btn btn-danger btn-sm" onclick="removeOfficer(${i})">✕</button>
        </div>`;
      }).join('')}
    </div>
    <button class="btn btn-ghost btn-sm" onclick="addOfficer()">+ Tambah Petugas</button>
    <h3>Penanggung Jawab (kolom tanda tangan kiri)</h3>
    <select onchange="DRAFT.pjId=this.value">
      ${pjOpts.map(p=>`<option value="${p.id}" ${DRAFT.pjId===p.id?'selected':''}>${escapeHtml(p.jabatan)} — ${escapeHtml(p.name)}</option>`).join('')}
    </select>`;
}
function addOfficer(){ DRAFT.officers.push({name:'',nip:''}); render(); }
function removeOfficer(i){ DRAFT.officers.splice(i,1); if(!DRAFT.officers.length) DRAFT.officers=[{name:'',nip:''}]; render(); }

function wilayahList(){ return SETTINGS.wilayah||[]; }
function selectedDesa(){ return wilayahList().find(d=>d.id===DRAFT.desaId)||null; }
function selectedDusun(){ const ds=selectedDesa(); return ds ? (ds.dusun||[]).find(u=>u.id===DRAFT.dusunId)||null : null; }
function recomputeLokasi(){
  const ds=selectedDesa(), du=selectedDusun();
  let parts=[];
  if(du) parts.push('DUSUN '+du.nama);
  if(DRAFT.rt) parts.push('RT '+DRAFT.rt);
  if(ds) parts.push('DS. '+ds.desa);
  DRAFT.lokasi = parts.join(' ');
}
function onDesaChange(v){ DRAFT.desaId=v; DRAFT.dusunId=''; DRAFT.rt=''; recomputeLokasi(); render(); }
function onDusunChange(v){ DRAFT.dusunId=v; DRAFT.rt=''; recomputeLokasi(); render(); }
function onRtChange(v){ DRAFT.rt=v; recomputeLokasi(); render(); }
function stepKegiatan(){
  const ds=selectedDesa(), du=selectedDusun();
  const hasWilayah = wilayahList().length>0;
  return `
    <h3>2. Waktu & Kegiatan</h3>
    <div class="grid2">
      <div><label>Hari</label><input type="text" placeholder="mis. Rabu" value="${escapeHtml(DRAFT.hari)}" oninput="DRAFT.hari=this.value"></div>
      <div><label>Tanggal</label><input type="date" value="${DRAFT.tanggal||''}" oninput="DRAFT.tanggal=this.value"></div>
    </div>
    <label>Kegiatan / Maksud dan Tujuan</label>
    <textarea oninput="DRAFT.kegiatan=this.value">${escapeHtml(DRAFT.kegiatan)}</textarea>
    <h3>Tujuan / Lokasi Kunjungan</h3>
    ${hasWilayah?`
    <div class="grid3 wilayah-selects">
      <div><label>Desa</label>
        <select class="wilayah-select" onchange="onDesaChange(this.value)" aria-label="Pilih Desa">
          <option value="">— Pilih Desa —</option>
          ${wilayahList().map(d=>`<option value="${d.id}" ${DRAFT.desaId===d.id?'selected':''}>${escapeHtml(d.desa)}</option>`).join('')}
        </select>
      </div>
      <div><label>Dusun</label>
        <select class="wilayah-select" onchange="onDusunChange(this.value)" ${!ds?'disabled':''} aria-label="Pilih Dusun">
          <option value="">— Pilih Dusun —</option>
          ${((ds&&ds.dusun)||[]).map(u=>`<option value="${u.id}" ${DRAFT.dusunId===u.id?'selected':''}>${escapeHtml(u.nama)}</option>`).join('')}
        </select>
      </div>
      <div><label>RT</label>
        <select class="wilayah-select" onchange="onRtChange(this.value)" ${!du?'disabled':''} aria-label="Pilih RT">
          <option value="">— Pilih RT —</option>
          ${((du&&du.rtList)||[]).map(rt=>`<option value="${rt}" ${DRAFT.rt===rt?'selected':''}>${escapeHtml(rt)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="hint">Lokasi tujuan otomatis tersusun: <b>${escapeHtml(DRAFT.lokasi||'-')}</b></div>`
    :`<div class="hint">Daftar desa/dusun/RT belum diisi admin. Buka menu <b>⚙️ Pengaturan</b> untuk menambahkannya, atau isi lokasi manual di bawah ini untuk sementara.</div>
    <label>Lokasi (manual)</label>
    <input type="text" value="${escapeHtml(DRAFT.lokasi)}" oninput="DRAFT.lokasi=this.value">`}
    <div class="hint">Kolom ringkasan di bagian atas surat otomatis mengikuti isian ini.</div>`;
}
function stepLaporan(){
  const enabled=SETTINGS.baseFields||{};
  const extra=SETTINGS.extraFields||[];
  const fields=REPORT_MASTER_FIELDS.filter(f=>f.key==='masalah'||f.key==='rekomendasi'||enabled[f.key]!==false);
  const options=REPORT_MASTER.map(x=>`<option value="${x.id}" ${String(DRAFT.reportTemplateId)===String(x.id)?'selected':''}>ID ${escapeHtml(String(x.id))}</option>`).join('');
  return `<h3>3. Laporan Kegiatan</h3>
    <div class="hint" style="margin-bottom:12px">
      Pilih <b>1 ID / Template Laporan</b>. Semua 9 bagian akan otomatis diambil dari <b>baris yang sama</b>, lalu dapat diedit sebelum disimpan.
    </div>
    <div class="report-master-row" style="margin-bottom:16px">
      <label><b>Template / ID Laporan</b></label>
      <select onchange="applyReportTemplate(this.value)">
        <option value="">— Pilih ID / Template Laporan —</option>
        ${options}
      </select>
      ${DRAFT.reportTemplateId?`<div class="hint" style="margin-top:8px">✓ Template ID <b>${escapeHtml(String(DRAFT.reportTemplateId))}</b> telah dimuat.</div>`:''}
    </div>
    ${fields.map(f=>`<div class="report-master-row">
      <label><b>${escapeHtml(f.label)}</b></label>
      <textarea oninput="setReportValue('${f.key}',this.value)" placeholder="Isi ${escapeHtml(f.label.replace(/^[a-i]\. /,''))}...">${escapeHtml(reportValue(f.key))}</textarea>
    </div>`).join('')}
    ${extra.length?`<div class="hint" style="margin-top:6px">Pertanyaan tambahan (diatur admin):</div>`:''}
    ${extra.map(ef=>`<label>${escapeHtml(ef.label)}</label><textarea oninput="DRAFT.extraFieldValues['${ef.id}']=this.value">${escapeHtml(DRAFT.extraFieldValues[ef.id]||'')}</textarea>`).join('')}`;
}
function stepMasalah(){
  return `<h3>4. Masalah & Rekomendasi</h3>
    <label>Masalah</label><textarea oninput="DRAFT.masalah=this.value">${escapeHtml(DRAFT.masalah)}</textarea>
    <label>Rekomendasi</label><textarea oninput="DRAFT.rekomendasi=this.value">${escapeHtml(DRAFT.rekomendasi)}</textarea>`;
}
function autoCollageRows(n){
  n=Number(n)||0;
  if(n<=0) return [];
  // Setiap baris selalu mengisi 100% lebar kanvas. Ini menghilangkan
  // sel/ruang kosong pada baris terakhir seperti grid 3 kolom biasa.
  const plans={1:[1],2:[2],3:[3],4:[2,2],5:[3,2],6:[3,3],7:[3,2,2],8:[3,3,2],9:[3,3,3]};
  return plans[n]||[3,3,3].slice(0,Math.ceil(n/3));
}
function autoCollageCols(n){
  const rows=autoCollageRows(n);
  return rows.length?Math.max(...rows):1;
}
function autoCollageClass(n){
  n=Number(n)||0;
  return `auto-${Math.min(Math.max(n,1),9)}`;
}
function collageCfg(){
  DRAFT.collage=DRAFT.collage||{template:'auto',ratio:'1:1',gap:8};
  return DRAFT.collage;
}
function setCollage(k,v){ collageCfg()[k]=v; render(); }
function collageTemplateButton(id,label,mini){
  const c=collageCfg();
  return `<button type="button" class="collage-template ${c.template===id?'active':''}" onclick="setCollage('template','${id}')"><span class="collage-mini ${mini}">${[1,2,3,4].map(i=>`<i></i>`).join('')}</span><span>${label}</span></button>`;
}
function collageStyle(c,n){
  const ratio=(c.ratio||'1:1').replace(':',' / ');
  let cols;
  if(!c.template||c.template==='auto') cols=autoCollageCols(n);
  else cols=c.template==='grid-2'||c.template==='hero-2'||c.template==='square-2'?2:3;
  return `--cgap:${Number(c.gap)||0}px;--cratio:${ratio};--ccols:${cols}`;
}
function stepFoto(){
  const max=SETTINGS.photoMax||9, c=collageCfg();
  const templates=`<button type="button" class="collage-template ${(!c.template||c.template==='auto')?'active':''}" onclick="setCollage('template','auto')"><span class="collage-mini mauto">${[1,2,3,4].map(i=>`<i></i>`).join('')}</span><span>Otomatis</span></button>`
    +collageTemplateButton('grid-2','2 Kolom','m2')+collageTemplateButton('hero-2','Utama + 2','mhero')+collageTemplateButton('grid-3','3 Kolom','m3')+collageTemplateButton('square-2','2×2','m22')+collageTemplateButton('single','Satu per Baris','m1');
  const ratios=['1:1','3:4','4:5','9:16','4:3','5:4','16:9'];
  return `<h3>5. Dokumentasi Foto Kegiatan (maks ${max} foto)</h3>
    <div class="collage-panel">
      <div class="collage-head"><b>Kolase Foto</b><span class="muted small">Otomatis menyesuaikan jumlah foto yang diunggah — atau pilih tata letak manual</span></div>
      <div class="collage-templates">${templates}</div>
      <div class="collage-controls">
        <div><label>Rasio Foto</label><div class="ratio-list">${ratios.map(r=>`<button type="button" class="ratio-btn ${c.ratio===r?'active':''}" onclick="setCollage('ratio','${r}')">${r}</button>`).join('')}</div></div>
        <div class="gap-control"><label>Jarak <span id="gap-val">${c.gap||0}px</span></label><input type="range" min="0" max="24" step="1" value="${c.gap||0}" oninput="DRAFT.collage.gap=Number(this.value);document.getElementById('gap-val').textContent=this.value+'px';document.getElementById('collage-live').style.cssText=collageStyle(DRAFT.collage,DRAFT.photos.length)"></div>
      </div>
    </div>
    <div id="collage-live" class="collage-live ${(!c.template||c.template==='auto')?'auto-collage '+autoCollageClass(DRAFT.photos.length):c.template}" style="${collageStyle(c,DRAFT.photos.length)}">
      ${(!c.template||c.template==='auto') ? (()=>{let k=0; return autoCollageRows(DRAFT.photos.length).map(cols=>`<div class="collage-row row-${cols}">${DRAFT.photos.slice(k,k+cols).map((p)=>{const i=k++; return `<div class="collage-item"><div class="collage-photo"><img src="${p.url}" alt="Foto ${i+1}" loading="lazy"><button class="rm" title="Hapus foto" onclick="removePhoto(${i})">✕</button></div><input class="photo-cap" placeholder="Keterangan foto ${i+1}" value="${escapeHtml(p.caption||'')}" oninput="DRAFT.photos[${i}].caption=this.value"></div>`;}).join('')}</div>`).join('')})() : DRAFT.photos.map((p,i)=>`<div class="collage-item"><div class="collage-photo"><img src="${p.url}" alt="Foto ${i+1}" loading="lazy"><button class="rm" title="Hapus foto" onclick="removePhoto(${i})">✕</button></div><input class="photo-cap" placeholder="Keterangan foto ${i+1}" value="${escapeHtml(p.caption||'')}" oninput="DRAFT.photos[${i}].caption=this.value"></div>`).join('')}
      ${DRAFT.photos.length<max?`<button class="collage-add" onclick="addPhoto()">＋<span>Tambah Foto</span></button>`:''}
    </div>
    ${DRAFT.photos.length?`<div class="collage-summary"><span>✓ ${DRAFT.photos.length} foto dipilih</span><button type="button" class="btn btn-primary btn-sm" onclick="addPhoto()">＋ Tambah Foto</button></div>`:''}`;
}
function addPhoto(){
  const max=Number(SETTINGS.photoMax||9);
  const remaining=Math.max(0,max-(DRAFT.photos||[]).length);
  if(!remaining){ toast(`Maksimal ${max} foto.`); return; }
  pickAndUpload('image/*', results=>{
    for(const res of results) DRAFT.photos.push({path:res.path,url:res.url,caption:''});
    render();
  }, {multiple:true,multiResult:true,max:remaining});
}
function removePhoto(i){ DRAFT.photos.splice(i,1); render(); }
function stepReview(){ return `<h3>6. Review</h3>${renderDocPreview(DRAFT)}`; }

/* ============================== PREVIEW PAGE ============================== */
function renderPreviewPage(){
  const id=(location.hash.split('/')[2]);
  const item=LPD_LIST.find(x=>x.id===id);
  if(!item) return `<div class="card"><div class="empty">Memuat data…</div></div>`;
  return `
    <div class="toolbar">
      <button class="btn btn-outline" onclick="go('dashboard')">← Kembali</button>
      <div class="row">
        ${canEditLpd(item)?`<button class="btn btn-ghost" onclick="go('edit/${item.id}')">Edit</button>`:''}
        <button class="btn btn-primary" onclick="downloadWord('${item.id}')">⬇ Download Word</button>
      </div>
    </div>
    <div class="card">${renderDocPreview(item)}</div>`;
}
function pjFor(id){
  const list=Array.isArray(SETTINGS?.pjOptions)?SETTINGS.pjOptions:[];
  return list.find(p=>p.id===id) || list.find(p=>p.id===SETTINGS?.defaultPjId) || list[0] || {id:'pj1',jabatan:'PJ UKM Esensial',name:'',nip:''};
}
function renderDocPreview(d){
  const kop=SETTINGS.kop;
  const T=deepMerge(DEFAULT_SETTINGS().typography, SETTINGS.typography||{});
  const stJudul=`font-size:${T.judul.sizePt||13}pt;font-weight:${T.judul.bold?700:400}`;
  const stKop=`font-weight:${T.kop.bold?700:400}`;
  const kopSize=(T.kop.sizePt||11);
  const stTabel=`font-size:${T.isiTabel.sizePt||10}pt`;
  const stTabelVal=`font-weight:${T.isiTabel.bold?700:400}`;
  const stTtd=`font-size:${T.tandaTangan.sizePt||10}pt;font-weight:${T.tandaTangan.bold?700:400}`;
  const stDok=`font-size:${T.dokumentasi.sizePt||10}pt`;
  const stDokVal=`font-weight:${T.dokumentasi.bold?700:400}`;
  const officersTxt=(d.officers||[]).filter(o=>o.name).map((o,i)=>`${i+1}. ${o.name}${o.nip?' / NIP '+o.nip:''}`).join('<br>');
  const enabled=SETTINGS.baseFields||{};
  const rows=[
    ['1. Dasar', `1. SPT Nomor : ${d.sptNumber||'-'}<br>2. SPD Nomor : ${d.spdNumber||'-'}`],
    ['2. Maksud dan Tujuan', esc2br(d.kegiatan)],
    ['3. Waktu Pelaksanaan', escapeHtml([d.hari,d.tanggal?formatTanggalContoh(d.tanggal):''].filter(Boolean).join(' ')||'-')],
    ['4. Nama Petugas', officersTxt||'-'],
    ['5. Tujuan', escapeHtml(d.lokasi||'-')],
  ];
  const lapRows=BASE_FIELDS.filter(f=>enabled[f.key]!==false).map(f=>[f.label, esc2br(d.fields[f.key])]);
  const extraRows=(SETTINGS.extraFields||[]).map(ef=>[escapeHtml(ef.label), esc2br(d.extraFieldValues[ef.id])]);
  const tailRows=[['7. Masalah', esc2br(d.masalah)],['8. Rekomendasi', esc2br(d.rekomendasi)]];
  const pj=pjFor(d.pjId); const k=SETTINGS.kepala;
  const tanggalSurat=d.tanggal?formatTanggalID(d.tanggal):'...................';
  const officerColsPrev=(d.officers||[]).filter(o=>o.name).slice(0,SETTINGS.officerColumns||2);
  return `
    <div class="doc-preview">
      <div class="center" style="${stKop}"><b>${escapeHtml(kop.baris1)}</b><br><b>${escapeHtml(kop.baris2)}</b><br><b>${escapeHtml(kop.baris3)}</b><br>
      <span style="font-size:${kopSize+4}pt"><b>${escapeHtml(kop.puskesmas)}</b></span><br>
      <span class="small" style="font-weight:400">${escapeHtml(kop.alamat)}</span><br><span class="small" style="font-weight:400">Email: ${escapeHtml(kop.email)}</span></div><hr>
      <h4 style="${stJudul}">LAPORAN PERJALANAN DINAS</h4>
      <div style="${stTabel}">
        ${[...rows,...lapRows,...extraRows].map(r=>`<div class="kv"><b>${escapeHtml(r[0])}</b> : <span style="${stTabelVal}">${r[1]||'-'}</span></div>`).join('')}
        ${tailRows.map(r=>`<div class="kv"><b>${escapeHtml(r[0])}</b> : <span style="${stTabelVal}">${r[1]||'-'}</span></div>`).join('')}
      </div>

      <div style="margin-top:16px;${stTtd};width:88%;margin-left:8%;display:grid;grid-template-columns:1fr 1fr;column-gap:24px;align-items:start;">
        <div style="text-align:center">
          ${escapeHtml(pj.jabatan||'PJ UKM Esensial')}<br><br><br>
          <b>${escapeHtml(pj.name||'')}</b><br>NIP. ${escapeHtml(pj.nip||'')}
        </div>
        <div style="text-align:center">
          ${escapeHtml(kop.kotaSurat)}, ${tanggalSurat}<br>Pelaksana Kegiatan<br><br>
          ${(officerColsPrev.length?officerColsPrev:[{name:''}]).map((o,i)=>`${i+1}. <b>${escapeHtml(o.name||'')}</b> ........................`).join('<br>')}
        </div>
      </div>
      <div class="center" style="margin-top:14px;${stTtd};width:50%;margin-left:25%;">
        Mengetahui,<br>${escapeHtml(k.jabatan)}<br><br><br><b>${escapeHtml(k.name)}</b><br>NIP. ${escapeHtml(k.nip)}
      </div>
      <div style="margin-top:16px"><b>DOKUMENTASI KEGIATAN</b></div>
      <div class="collage-live ${(!(d.collage&&d.collage.template)||d.collage.template==='auto')?'':d.collage.template}" style="${collageStyle(d.collage||{template:'auto',ratio:'1:1',gap:8},(d.photos||[]).length)};margin-top:8px">
        ${(d.photos||[]).map(p=>`<div class="collage-item"><div class="collage-photo"><img src="${p.url}" alt=""></div>${p.caption?`<div class="small center">${escapeHtml(p.caption)}</div>`:''}</div>`).join('')||'<span class="muted small">Belum ada foto.</span>'}
      </div>
      <h4 style="margin-top:14px">${escapeHtml(kop.puskesmas)}</h4>
      <div style="${stDok}">
        <div class="kv"><b>Hari, Tanggal</b> : <span style="${stDokVal}">${escapeHtml([d.hari,d.tanggal?formatTanggalContoh(d.tanggal):''].filter(Boolean).join(' ')||'-')}</span></div>
        <div class="kv"><b>Kegiatan</b> : <span style="${stDokVal}">${escapeHtml(d.kegiatan||'-')}</span></div>
        <div class="kv"><b>Petugas</b> : <span style="${stDokVal}">${(d.officers||[]).map(o=>o.name).filter(Boolean).join(', ')||'-'}</span></div>
        <div class="kv"><b>Sasaran</b> : <span style="${stDokVal}">${escapeHtml((d.fields&&d.fields.sasaran)||'-')}</span></div>
        <div class="kv"><b>Tujuan</b> : <span style="${stDokVal}">${escapeHtml(d.lokasi||'-')}</span></div>
      </div>
    </div>`;
}
function esc2br(s){ return escapeHtml(s||'').replace(/\n/g,'<br>'); }
function formatTanggalContoh(iso){
  if(!iso) return '';
  const parts=String(iso).split('-');
  return parts.length===3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : String(iso);
}
function formatTanggalID(iso){
  try{ const d=new Date(iso+'T00:00:00');
    const bulan=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    return d.getDate()+' '+bulan[d.getMonth()]+' '+d.getFullYear();
  }catch(e){ return iso; }
}

/* ============================== SETTINGS (admin) ============================== */
function renderSettings(){
  if(!ME.isAdmin) return `<div class="card"><div class="empty">Halaman ini khusus admin.</div></div>`;
  const s=window._settingsDraft ? window._settingsDraft : JSON.parse(JSON.stringify(SETTINGS));
  window._settingsDraft=s;
  const kop=s.kop, paper=s.paper, k=s.kepala;
  return `
    <div class="card">
      <h2>⚙️ Pengaturan Aplikasi</h2>
      <h3>Kop Surat</h3>
      <div class="grid2">
        <div><label>Baris 1</label><input type="text" value="${escapeHtml(kop.baris1)}" oninput="window._settingsDraft.kop.baris1=this.value"></div>
        <div><label>Baris 2</label><input type="text" value="${escapeHtml(kop.baris2)}" oninput="window._settingsDraft.kop.baris2=this.value"></div>
        <div><label>Baris 3</label><input type="text" value="${escapeHtml(kop.baris3)}" oninput="window._settingsDraft.kop.baris3=this.value"></div>
        <div><label>Nama Puskesmas</label><input type="text" value="${escapeHtml(kop.puskesmas)}" oninput="window._settingsDraft.kop.puskesmas=this.value"></div>
        <div><label>Alamat</label><input type="text" value="${escapeHtml(kop.alamat)}" oninput="window._settingsDraft.kop.alamat=this.value"></div>
        <div><label>Email</label><input type="text" value="${escapeHtml(kop.email)}" oninput="window._settingsDraft.kop.email=this.value"></div>
        <div><label>Kota untuk tanggal surat</label><input type="text" value="${escapeHtml(kop.kotaSurat)}" oninput="window._settingsDraft.kop.kotaSurat=this.value"></div>
      </div>
      <label>Logo (opsional)</label>
      <button class="imgpick" onclick="pickAndUpload('image/*',res=>{window._settingsDraft.kop.logoPath=res.path; window._settingsDraft.kop.logoUrl=res.url; document.getElementById('logo-preview').innerHTML='<div class=\\'stamp-preview\\'><img src=\\''+res.url+'\\'></div>';})">Unggah Logo</button>
      <div id="logo-preview" style="margin-top:8px">${kop.logoUrl?`<div class="stamp-preview"><img src="${kop.logoUrl}"></div>`:''}</div>

      <h3>Ukuran Kertas & Margin</h3>
      <div class="grid3">
        <div><label>Preset Kertas</label>
          <select onchange="applyPaperPreset(this.value)">
            ${Object.keys(PAPER_PRESETS).map(p=>`<option value="${p}" ${paper.preset===p?'selected':''}>${p}</option>`).join('')}
            <option value="Custom" ${paper.preset==='Custom'?'selected':''}>Custom</option>
          </select></div>
        <div><label>Lebar (cm)</label><input type="number" step="0.1" value="${paper.widthCm}" oninput="window._settingsDraft.paper.widthCm=parseFloat(this.value)||0; window._settingsDraft.paper.preset='Custom'"></div>
        <div><label>Tinggi (cm)</label><input type="number" step="0.1" value="${paper.heightCm}" oninput="window._settingsDraft.paper.heightCm=parseFloat(this.value)||0; window._settingsDraft.paper.preset='Custom'"></div>
      </div>
      <div class="grid3">
        <div><label>Margin Atas (cm)</label><input type="number" step="0.1" value="${paper.marginTopCm}" oninput="window._settingsDraft.paper.marginTopCm=parseFloat(this.value)||0"></div>
        <div><label>Margin Bawah (cm)</label><input type="number" step="0.1" value="${paper.marginBottomCm}" oninput="window._settingsDraft.paper.marginBottomCm=parseFloat(this.value)||0"></div>
        <div><label>Margin Kiri (cm)</label><input type="number" step="0.1" value="${paper.marginLeftCm}" oninput="window._settingsDraft.paper.marginLeftCm=parseFloat(this.value)||0"></div>
      </div>
      <div class="grid3"><div><label>Margin Kanan (cm)</label><input type="number" step="0.1" value="${paper.marginRightCm}" oninput="window._settingsDraft.paper.marginRightCm=parseFloat(this.value)||0"></div></div>

      <h3>Seri Penomoran SPT/SPD (per jenis kegiatan / bidang)</h3>
      <div class="muted small" style="margin-bottom:8px">Buat seri terpisah untuk tiap bidang/program (mis. Umum, Promkes, PTM, KIA) supaya nomor SPT/SPD masing-masing berjalan sendiri-sendiri tanpa bentrok.</div>
      <div id="series-list">
        ${SERIES.map(sr=>`
          <div class="card" style="padding:12px;margin-bottom:10px">
            <div class="row" style="align-items:center;justify-content:space-between">
              <input type="text" value="${escapeHtml(sr.name)}" style="max-width:220px;font-weight:700" onchange="updateSeries('${sr.id}',{name:this.value})">
              <div class="row">
                ${sr.isDefault?`<span class="tag">Default</span>`:`<button class="btn btn-outline btn-sm" onclick="setDefaultSeries('${sr.id}')">Jadikan Default</button>`}
                <button class="btn btn-danger btn-sm" onclick="deleteSeries('${sr.id}')">Hapus</button>
              </div>
            </div>
            <div class="grid2" style="margin-top:8px">
              <div><label>Format SPT</label><input type="text" value="${escapeHtml(sr.sptFormat)}" onchange="updateSeries('${sr.id}',{spt_format:this.value})"></div>
              <div><label>Counter SPT berikutnya</label><input type="number" value="${sr.sptCounter}" onchange="updateSeries('${sr.id}',{spt_counter:parseInt(this.value)||1})"></div>
              <div><label>Format SPD</label><input type="text" value="${escapeHtml(sr.spdFormat)}" onchange="updateSeries('${sr.id}',{spd_format:this.value})"></div>
              <div><label>Counter SPD berikutnya</label><input type="number" value="${sr.spdCounter}" onchange="updateSeries('${sr.id}',{spd_counter:parseInt(this.value)||1})"></div>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="addSeries()">+ Tambah Seri / Jenis Kegiatan</button>

      <h3>Data Wilayah (Desa, Dusun, RT)</h3>
      <div class="muted small" style="margin-bottom:8px">Isi daftar desa, dusun, dan RT tujuan kunjungan di sini. Saat membuat LPD, pengguna cukup memilih dari daftar ini — tidak perlu mengetik manual.</div>
      <div id="wilayah-list">
        ${(s.wilayah||[]).map((ds,di)=>`
          <div class="card" style="padding:12px;margin-bottom:10px">
            <div class="row" style="align-items:center;justify-content:space-between">
              <div style="flex:1;min-width:260px">
                <label>Nama Desa (pisahkan dengan koma)</label>
                <input type="text" placeholder="Contoh: Kalianget, Paberasan, Marengan" value="${escapeHtml(ds.desa)}" style="width:100%;font-weight:700"
                  onchange="setDesaCsv(${di},this.value)">
              </div>
              <button class="btn btn-danger btn-sm" onclick="removeDesa(${di})">Hapus Desa</button>
            </div>
            <div style="margin-top:8px">
              ${(ds.dusun||[]).map((du,ui)=>`
                <div class="field-row">
                  <div class="col"><label>Nama Dusun (pisahkan dengan koma)</label><input type="text" placeholder="Contoh: Krajan, Karang Anyar, Tegal" value="${escapeHtml(du.nama)}"
                    onchange="setDusunCsv(${di},${ui},this.value)"></div>
                  <div class="col"><label>Daftar RT (pisahkan dengan koma)</label><input type="text" placeholder="Contoh: 001, 002, 003" value="${escapeHtml((du.rtList||[]).join(', '))}"
                    onchange="window._settingsDraft.wilayah[${di}].dusun[${ui}].rtList=this.value.split(',').map(x=>x.trim()).filter(Boolean)"></div>
                  <button class="btn btn-danger btn-sm" onclick="removeDusun(${di},${ui})">✕</button>
                </div>`).join('')}
            </div>
            <button class="btn btn-ghost btn-sm" onclick="addDusun(${di})">+ Tambah Dusun</button>
          </div>`).join('') || `<div class="muted small" style="margin-bottom:8px">Belum ada data desa.</div>`}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="addDesa()">+ Tambah Desa</button>

      <h3>PJ UKM Esensial</h3>
      <div class="muted small" style="margin-bottom:8px">Nama dan NIP di bawah ini akan otomatis digunakan pada kolom tanda tangan kiri di dokumen Word. Jika PJ berganti, cukup ubah di sini lalu klik Simpan Pengaturan — tidak perlu mengedit source website.</div>
      ${(()=>{
        const p=s.pjOptions.find(x=>x.id===s.defaultPjId)||s.pjOptions[0]||{id:'pj1',jabatan:'PJ UKM Esensial',name:'',nip:''};
        const i=Math.max(0,s.pjOptions.findIndex(x=>x.id===p.id));
        return `<div class="card" style="padding:14px;margin-bottom:10px">
          <div class="grid3">
            <div><label>Jabatan</label><input type="text" value="${escapeHtml(p.jabatan||'PJ UKM Esensial')}" oninput="window._settingsDraft.pjOptions[${i}].jabatan=this.value"></div>
            <div><label>Nama PJ UKM Esensial</label><input type="text" placeholder="Nama lengkap" value="${escapeHtml(p.name||'')}" oninput="window._settingsDraft.pjOptions[${i}].name=this.value"></div>
            <div><label>NIP PJ UKM Esensial</label><input type="text" placeholder="NIP" value="${escapeHtml(p.nip||'')}" oninput="window._settingsDraft.pjOptions[${i}].nip=this.value"></div>
          </div>
        </div>`;
      })()}

      <h3>Kepala Puskesmas & Stempel</h3>
      <div class="grid3">
        <div><label>Jabatan</label><input type="text" value="${escapeHtml(k.jabatan)}" oninput="window._settingsDraft.kepala.jabatan=this.value"></div>
        <div><label>Nama</label><input type="text" value="${escapeHtml(k.name)}" oninput="window._settingsDraft.kepala.name=this.value"></div>
        <div><label>NIP</label><input type="text" value="${escapeHtml(k.nip)}" oninput="window._settingsDraft.kepala.nip=this.value"></div>
      </div>
      <div class="row" style="align-items:center;margin-top:6px">
        <div class="stamp-preview" id="stamp-preview">${k.stampUrl?`<img src="${k.stampUrl}">`:'Stempel'}</div>
        <button class="imgpick" onclick="pickAndUpload('image/*',res=>{window._settingsDraft.kepala.stampPath=res.path; window._settingsDraft.kepala.stampUrl=res.url; document.getElementById('stamp-preview').innerHTML='<img src=\\''+res.url+'\\'>';})">Unggah Gambar Stempel</button>
        <div class="stamp-preview" id="ttd-preview">${k.ttdUrl?`<img src="${k.ttdUrl}">`:'TTD'}</div>
        <button class="imgpick" onclick="pickAndUpload('image/*',res=>{window._settingsDraft.kepala.ttdPath=res.path; window._settingsDraft.kepala.ttdUrl=res.url; document.getElementById('ttd-preview').innerHTML='<img src=\\''+res.url+'\\'>';})">Unggah Gambar Tanda Tangan</button>
      </div>
      <div class="grid3" style="margin-top:10px">
        <div><label>Lebar stempel (cm)</label><input type="number" step="0.1" value="${k.stampWidthCm}" oninput="window._settingsDraft.kepala.stampWidthCm=parseFloat(this.value)||0"></div>
        <div><label>Geser horizontal stempel (cm)</label><input type="number" step="0.1" value="${k.stampOffsetXCm}" oninput="window._settingsDraft.kepala.stampOffsetXCm=parseFloat(this.value)||0"></div>
        <div><label>Geser vertikal stempel (cm)</label><input type="number" step="0.1" value="${k.stampOffsetYCm}" oninput="window._settingsDraft.kepala.stampOffsetYCm=parseFloat(this.value)||0"></div>
      </div>

      <h3>Kolom Tanda Tangan Pelaksana</h3>
      <input type="number" min="1" max="5" value="${s.officerColumns}" oninput="window._settingsDraft.officerColumns=parseInt(this.value)||1" style="max-width:120px">

      <h3>Bagian Laporan Kegiatan (aktif/nonaktif)</h3>
      <div class="grid2">
        ${BASE_FIELDS.map(f=>`<label style="display:flex;align-items:center;gap:8px;font-weight:500;color:var(--text)">
          <input type="checkbox" style="width:auto" ${s.baseFields[f.key]!==false?'checked':''} onchange="window._settingsDraft.baseFields['${f.key}']=this.checked">${f.label}</label>`).join('')}
      </div>

      <h3>Pertanyaan Tambahan (kustom)</h3>
      <div id="extra-list">
        ${s.extraFields.map((ef,i)=>`<div class="field-row">
          <div class="col"><label>Label pertanyaan</label><input type="text" value="${escapeHtml(ef.label)}" oninput="window._settingsDraft.extraFields[${i}].label=this.value"></div>
          <button class="btn btn-danger btn-sm" onclick="removeExtraField(${i})">✕</button></div>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="addExtraField()">+ Tambah Pertanyaan</button>

      <h3>Dokumentasi Foto</h3>
      <div class="grid2">
        <div><label>Maks jumlah foto</label><input type="number" min="1" max="20" value="${s.photoMax}" oninput="window._settingsDraft.photoMax=parseInt(this.value)||9"></div>
        <div><label>Jumlah kolom kolase</label><input type="number" min="1" max="5" value="${s.photoCols}" oninput="window._settingsDraft.photoCols=parseInt(this.value)||3"></div>
      </div>

      <h3>Ukuran & Ketebalan Tulisan (per bagian dokumen)</h3>
      <div class="muted small" style="margin-bottom:8px">Atur ukuran huruf (pt) dan tebal/tidaknya tulisan untuk tiap bagian dokumen Word secara terpisah.</div>
      <div class="grid2">
        ${[['judul','Judul (LAPORAN PERJALANAN DINAS)'],['kop','Kop Surat'],['isiTabel','Isi Laporan (Dasar s/d Rekomendasi)'],['tandaTangan','Tanda Tangan'],['dokumentasi','Dokumentasi Kegiatan (bawah foto)']].map(([key,label])=>{
          const tg=(s.typography&&s.typography[key])||{sizePt:10,bold:false};
          return `<div class="pj-row" style="flex-direction:column;align-items:stretch">
            <label style="margin-top:0">${label}</label>
            <div class="row" style="align-items:center;gap:14px">
              <div style="max-width:130px"><label class="small" style="margin:0 0 2px">Ukuran (pt)</label>
                <input type="number" min="6" max="36" step="0.5" value="${tg.sizePt}" oninput="window._settingsDraft.typography['${key}'].sizePt=parseFloat(this.value)||10"></div>
              <label style="display:flex;align-items:center;gap:6px;margin:14px 0 0;font-weight:500;color:var(--text)">
                <input type="checkbox" style="width:auto" ${tg.bold?'checked':''} onchange="window._settingsDraft.typography['${key}'].bold=this.checked"> Tebal (Bold)
              </label>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary" onclick="saveSettings(window._settingsDraft)">💾 Simpan Pengaturan</button>
    </div>`;
}
function applyPaperPreset(name){
  if(PAPER_PRESETS[name]){ window._settingsDraft.paper.preset=name; window._settingsDraft.paper.widthCm=PAPER_PRESETS[name].w; window._settingsDraft.paper.heightCm=PAPER_PRESETS[name].h; }
  else window._settingsDraft.paper.preset='Custom';
  render();
}
function addPjOption(){ window._settingsDraft.pjOptions.push({id:'pj'+Date.now(),jabatan:'',name:'',nip:''}); render(); }
function removePjOption(i){ window._settingsDraft.pjOptions.splice(i,1); render(); }
function csvNames(v){ return String(v||'').split(',').map(x=>x.trim()).filter(Boolean).map(x=>x.toUpperCase()); }
function setDesaCsv(di,value){
  const names=csvNames(value);
  const wilayah=window._settingsDraft.wilayah||[];
  const current=wilayah[di];
  if(!current) return;
  if(names.length<=1){ current.desa=names[0]||''; render(); return; }
  const baseDusun=JSON.parse(JSON.stringify(current.dusun||[]));
  wilayah.splice(di,1,...names.map((name,i)=>({
    id:'ds'+Date.now()+i, desa:name, dusun:JSON.parse(JSON.stringify(baseDusun))
  })));
  render();
}
function setDusunCsv(di,ui,value){
  const names=csvNames(value);
  const wilayah=window._settingsDraft.wilayah||[];
  const desa=wilayah[di];
  if(!desa || !desa.dusun || !desa.dusun[ui]) return;
  const current=desa.dusun[ui];
  if(names.length<=1){ current.nama=names[0]||''; render(); return; }
  const baseRt=[...(current.rtList||[])];
  desa.dusun.splice(ui,1,...names.map((name,i)=>({
    id:'du'+Date.now()+i, nama:name, rtList:[...baseRt]
  })));
  render();
}
function addDesa(){ window._settingsDraft.wilayah=window._settingsDraft.wilayah||[]; window._settingsDraft.wilayah.push({id:'ds'+Date.now(),desa:'',dusun:[]}); render(); }
function removeDesa(di){ window._settingsDraft.wilayah.splice(di,1); render(); }
function addDusun(di){ window._settingsDraft.wilayah[di].dusun=window._settingsDraft.wilayah[di].dusun||[]; window._settingsDraft.wilayah[di].dusun.push({id:'du'+Date.now(),nama:'',rtList:[]}); render(); }
function removeDusun(di,ui){ window._settingsDraft.wilayah[di].dusun.splice(ui,1); render(); }
function addExtraField(){ window._settingsDraft.extraFields.push({id:'ef'+Date.now(),label:''}); render(); }
function removeExtraField(i){ window._settingsDraft.extraFields.splice(i,1); render(); }

/* ============================== USERS / ADMIN MGMT ============================== */
function renderUsers(){
  if(!ME.isAdmin) return `<div class="card"><div class="empty">Halaman ini khusus admin.</div></div>`;
  return `
    <div class="card">
      <h2>👤 Kelola Pengguna & Admin</h2>
      <div class="muted small">Admin dapat mengubah kop surat, ukuran kertas, seri penomoran SPT/SPD, kolom tanda tangan, dan stempel. Pengguna lain tetap bisa membuat & mengedit LPD miliknya sendiri.</div>
      <div style="margin-top:14px">
        ${ALL_PROFILES.map(p=>`
          <div class="admin-list-item">
            <div style="flex:1">${escapeHtml(p.full_name||p.email)} <span class="muted small">${escapeHtml(p.email||'')}</span></div>
            ${p.is_admin?`<span class="badge-admin" style="margin-right:8px">ADMIN</span>`:''}
            <button class="btn btn-sm ${p.is_admin?'btn-danger':'btn-ghost'}" onclick="setAdmin('${p.id}', ${!p.is_admin})">${p.is_admin?'Cabut admin':'Jadikan admin'}</button>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ============================== UTIL ============================== */
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============================================================================
   DOCX GENERATION — .docx (OOXML) dibangun manual dengan JSZip, murni client-side.
   ============================================================================ */
const CM_TO_TWIP=566.9291339, CM_TO_EMU=360000;
function xmlEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function textRuns(text, rp){
  rp=rp||''; const lines=String(text==null?'':text).split('\n');
  return lines.map((line,i)=>{ const t=`<w:r>${rp}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`; return i<lines.length-1?t+`<w:r><w:br/></w:r>`:t; }).join('');
}
function rPr(o){ o=o||{}; let x='<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'; if(o.b)x+='<w:b/>'; if(o.i)x+='<w:i/>';
  x+=`<w:sz w:val="${(o.size||22)}"/><w:szCs w:val="${(o.size||22)}"/></w:rPr>`; return x; }
function para(text,o){ o=o||{}; let p='<w:pPr>'; p+=`<w:jc w:val="${o.align||'left'}"/>`; p+=`<w:spacing w:after="${o.after!=null?o.after:60}" w:line="276" w:lineRule="auto"/></w:pPr>`;
  const r=o.raw?o.raw:textRuns(text,rPr(o)); return `<w:p>${p}${r}</w:p>`; }
function emptyPara(){ return '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'; }
function tcBorders(){ return '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/></w:tcBorders>'; }
function tc(w,content,o){ o=o||{}; let p=`<w:tcPr><w:tcW w:w="${Math.round(w)}" w:type="dxa"/>`; if(o.colspan) p+=`<w:gridSpan w:val="${o.colspan}"/>`; p+=tcBorders(); p+=`<w:vAlign w:val="${o.valign||'top'}"/></w:tcPr>`; return `<w:tc>${p}${content||emptyPara()}</w:tc>`; }
function tr(cells){ return `<w:tr>${cells}</w:tr>`; }
function tableGrid(ws){ return '<w:tblGrid>'+ws.map(w=>`<w:gridCol w:w="${Math.round(w)}"/>`).join('')+'</w:tblGrid>'; }
function tableStart(ws){ return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr>${tableGrid(ws)}`; }
function inlineImageXml(relId,w,h,id){ return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${Math.round(w)}" cy="${Math.round(h)}"/><wp:docPr id="${id}" name="Picture${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`; }
function anchoredImageXml(relId,w,h,ox,oy,id){ return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251650000+id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>${Math.round(ox)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>${Math.round(oy)}</wp:posOffset></wp:positionV><wp:extent cx="${Math.round(w)}" cy="${Math.round(h)}"/><wp:wrapNone/><wp:docPr id="${id}" name="Stamp${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Stamp${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`; }
async function fetchAsBuffer(url){ const res=await fetch(url); if(!res.ok) throw new Error('fetch failed'); return await res.arrayBuffer(); }

function tcNB(w,content,o){ o=o||{}; let p=`<w:tcPr><w:tcW w:w="${Math.round(w)}" w:type="dxa"/>`; if(o.colspan) p+=`<w:gridSpan w:val="${o.colspan}"/>`;
  p+='<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>';
  p+=`<w:vAlign w:val="${o.valign||'top'}"/></w:tcPr>`; return `<w:tc>${p}${content||emptyPara()}</w:tc>`; }
function tableStartNB(ws){ return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr>${tableGrid(ws)}`; }

async function generateDocxBlob(d){
  const S=SETTINGS, kop=S.kop, k=S.kepala;
  // Migrasi otomatis dari setting default generator lama ke ukuran Word contoh.
  const rawPaper=S.paper||{};
  const isOldDefaultPaper=rawPaper.preset==='F4' && Number(rawPaper.widthCm)===21.5 && Number(rawPaper.heightCm)===33 && Number(rawPaper.marginLeftCm)===2.5 && Number(rawPaper.marginTopCm)===2 && Number(rawPaper.marginRightCm)===2 && Number(rawPaper.marginBottomCm)===2;
  const paper=isOldDefaultPaper ? {preset:'Custom',widthCm:21,heightCm:33,marginTopCm:2,marginBottomCm:2,marginLeftCm:2,marginRightCm:2} : deepMerge(DEFAULT_SETTINGS().paper,rawPaper);
  const rawT=S.typography||{};
  const oldTypography=Number(rawT.judul?.sizePt)===13 && Number(rawT.kop?.sizePt)===11 && Number(rawT.isiTabel?.sizePt)===10 && Number(rawT.tandaTangan?.sizePt)===10 && Number(rawT.dokumentasi?.sizePt)===10;
  const T=oldTypography ? DEFAULT_SETTINGS().typography : deepMerge(DEFAULT_SETTINGS().typography,rawT);
  // Format Word mengikuti dokumen contoh: 21 x 33 cm, margin 2 cm, isi 12 pt.
  const szJudul=Math.round((T.judul.sizePt||12)*2), bJudul=!!T.judul.bold;
  const szKop=Math.round((T.kop.sizePt||12)*2), bKop=!!T.kop.bold;
  const szKopPuskesmas=32; // 16 pt seperti dokumen acuan
  const szKopKecil=24;     // 12 pt
  const szTabel=Math.round((T.isiTabel.sizePt||12)*2), bTabel=!!T.isiTabel.bold;
  const szTtd=Math.round((T.tandaTangan.sizePt||12)*2), bTtd=!!T.tandaTangan.bold;
  const szDok=Math.round((T.dokumentasi.sizePt||12)*2), bDok=!!T.dokumentasi.bold;
  const pageWTwip=paper.widthCm*CM_TO_TWIP, pageHTwip=paper.heightCm*CM_TO_TWIP;
  const mT=paper.marginTopCm*CM_TO_TWIP, mB=paper.marginBottomCm*CM_TO_TWIP, mL=paper.marginLeftCm*CM_TO_TWIP, mR=paper.marginRightCm*CM_TO_TWIP;
  const contentW=pageWTwip-mL-mR;
  const media=[]; let relCounter=1, docPrCounter=100;
  async function addMedia(url){
    if(!url) return null;
    try{ const buf=await fetchAsBuffer(url); const relId='rId'+(1000+relCounter); const fileName=`image${relCounter}.png`; relCounter++;
      media.push({relId,fileName,buffer:buf}); return relId; }catch(e){ console.error('media fail',e); return null; }
  }

  // Kop surat: susunan teks sama dengan dokumen contoh. Logo tetap opsional.
  let kopXml='';
  const logoRel = kop.logoUrl ? await addMedia(kop.logoUrl) : null;
  if(logoRel){
    const logoW=1500;
    kopXml+=tableStartNB([logoW, Math.max(1,contentW-logoW)]);
    kopXml+=tr(
      tcNB(logoW, `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${inlineImageXml(logoRel,1.6*CM_TO_EMU,1.6*CM_TO_EMU,docPrCounter++)}</w:p>`,{valign:'center'})+
      tcNB(contentW-logoW,
        para(kop.baris1,{align:'center',b:bKop,size:szKop,after:0})+
        para(kop.baris2,{align:'center',b:bKop,size:szKop,after:0})+
        para(kop.baris3,{align:'center',b:bKop,size:szKop,after:0})+
        para(kop.puskesmas,{align:'center',b:true,size:szKopPuskesmas,after:0})+
        para(kop.alamat,{align:'center',size:szKopKecil,after:0})+
        para('Email : '+(kop.email||''),{align:'center',size:szKopKecil,after:0})
      ,{valign:'center'})
    );
    kopXml+='</w:tbl>';
  } else {
    kopXml+=para(kop.baris1,{align:'center',b:bKop,size:szKop,after:0})+
      para(kop.baris2,{align:'center',b:bKop,size:szKop,after:0})+
      para(kop.baris3,{align:'center',b:bKop,size:szKop,after:0})+
      para(kop.puskesmas,{align:'center',b:true,size:szKopPuskesmas,after:0})+
      para(kop.alamat,{align:'center',size:szKopKecil,after:0})+
      para('Email : '+(kop.email||''),{align:'center',size:szKopKecil,after:60});
  }
  const hr=`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="18" w:space="1" w:color="000000"/></w:pBdr><w:spacing w:after="160"/></w:pPr></w:p>`;
  let body=kopXml+hr;
  body+=para('LAPORAN PERJALANAN DINAS',{align:'center',b:bJudul,size:szJudul,after:200});
  function fieldLine(label,value,sz,boldValue){
    return para(null,{after:80,raw:
      `<w:r>${rPr({b:true,size:sz})}<w:t xml:space="preserve">${xmlEsc(label)}</w:t></w:r>`+
      `<w:r>${rPr({size:sz})}<w:t xml:space="preserve"> : </w:t></w:r>`+
      textRuns(value,rPr({size:sz,b:boldValue}))
    });
  }

  const formatTanggalContoh=(iso)=>{
    if(!iso) return '';
    const parts=String(iso).split('-');
    return parts.length===3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : String(iso);
  };
  const officers=(d.officers||[]).filter(o=>o.name);
  const officersTxt=officers.map((o,i)=>`${i+1}. ${o.name}${o.nip?' / NIP '+o.nip:''}`).join('\n');
  const enabled=S.baseFields||{};
  const rowWidths=[420,2835,285,Math.max(1,contentW-420-2835-285)];
  const rowCell=(no,label,value,opts={})=>{
    const labelBold=opts.labelBold!==false;
    return tr(
      tcNB(rowWidths[0],para(no||'', {align:'center',size:szTabel,after:0,b:false}))+
      tcNB(rowWidths[1],para(label||'', {size:szTabel,after:0,b:labelBold}))+
      tcNB(rowWidths[2],para(':',{align:'center',size:szTabel,after:0,b:false}))+
      tcNB(rowWidths[3],para(value||'-',{size:szTabel,after:0,b:bTabel}))
    );
  };

  // Tabel utama 4 kolom: No | Bagian | : | Isi, sama seperti dokumen acuan.
  let mainTable=tableStartNB(rowWidths);
  mainTable+=rowCell('1.','Dasar',`1.    SPT Nomor : ${d.sptNumber||'-'}\n2.    SPD Nomor : ${d.spdNumber||'-'}`,{labelBold:false});
  mainTable+=rowCell('2.','Maksud dan Tujuan',d.kegiatan||'-',{labelBold:false});
  mainTable+=rowCell('3.','Waktu Pelaksanaan',[d.hari,d.tanggal?formatTanggalContoh(d.tanggal):''].filter(Boolean).join(' ')||'-',{labelBold:false});
  mainTable+=rowCell('4.','Nama Petugas',officersTxt||'-',{labelBold:false});
  mainTable+=rowCell('5.','Tujuan',d.lokasi||'-',{labelBold:false});
  mainTable+=rowCell('6.','Laporan Kegiatan','',{labelBold:false});
  BASE_FIELDS.filter(f=>enabled[f.key]!==false).forEach(f=>{
    mainTable+=rowCell('',f.label,d.fields[f.key]||'-',{labelBold:true});
  });
  (S.extraFields||[]).forEach(ef=>{
    mainTable+=rowCell('',ef.label,d.extraFieldValues[ef.id]||'-',{labelBold:true});
  });
  mainTable+=rowCell('', 'h. Masalah', d.masalah||'-',{labelBold:true});
  mainTable+=rowCell('', 'i. Rekomendasi', d.rekomendasi||'-',{labelBold:true});
  mainTable+='</w:tbl>';
  body+=mainTable+emptyPara();

  // Tanda tangan: dibuat tanpa garis tabel agar menyerupai susunan Word contoh.
  const pj=pjFor(d.pjId);
  const officerCols=officers.slice(0,Math.max(1,S.officerColumns||2));

  const sigCount=Math.max(1,officerCols.length);
  // Susunan tanda tangan berbentuk segitiga sama kaki.
  const sigWidths=[
    Math.round(contentW*0.12),
    Math.round(contentW*0.38),
    Math.round(contentW*0.38),
    Math.max(1,Math.round(contentW*0.12))
  ];
  let sigTbl=tableStartNB(sigWidths);
  let pjCell=para(pj.jabatan||'PJ UKM Esensial',{align:'center',size:szTtd,after:0,b:bTtd})+emptyPara()+emptyPara()+para(pj.name||'',{align:'center',size:szTtd,after:0,b:true})+para('NIP. '+(pj.nip||''),{align:'center',size:szTtd,after:0,b:bTtd});
  let officerCell='';
  const tanggalSurat=d.tanggal?formatTanggalContoh(d.tanggal):'...................';
  officerCell+=para(kop.kotaSurat+', '+tanggalSurat,{align:'center',size:szTtd,after:0,b:bTtd})+para('Pelaksana Kegiatan',{align:'center',size:szTtd,after:0,b:bTtd})+emptyPara();
  const officerList=officerCols.length?officerCols:[{name:''}];
  officerList.forEach((o,i)=>{ officerCell+=para(`${i+1}. ${o.name||''} ........................`,{align:'center',size:szTtd,after:0,b:!!o.name}); });
  sigTbl+=tr(
    tcNB(sigWidths[0],emptyPara())+
    tcNB(sigWidths[1],pjCell)+
    tcNB(sigWidths[2],officerCell)+
    tcNB(sigWidths[3],emptyPara())
  );
  let kepalaContent=para('Mengetahui,',{align:'center',size:szTtd,after:0,b:bTtd})+para(k.jabatan||'',{align:'center',size:szTtd,after:0,b:bTtd});
  const ttdRel=k.ttdUrl?await addMedia(k.ttdUrl):null;
  const stampRel=k.stampUrl?await addMedia(k.stampUrl):null;
  let nameLineRaw='';
  if(ttdRel) nameLineRaw+=inlineImageXml(ttdRel,(k.ttdWidthCm||3.2)*CM_TO_EMU,(k.ttdWidthCm||3.2)*0.5*CM_TO_EMU,docPrCounter++);
  else kepalaContent+=emptyPara()+emptyPara();
  if(stampRel) nameLineRaw+=anchoredImageXml(stampRel,(k.stampWidthCm||2.8)*CM_TO_EMU,(k.stampWidthCm||2.8)*CM_TO_EMU,(k.stampOffsetXCm||0)*CM_TO_EMU,(k.stampOffsetYCm||0)*CM_TO_EMU,docPrCounter++);
  if(nameLineRaw) kepalaContent+=para(null,{align:'center',after:0,raw:nameLineRaw});
  kepalaContent+=para(k.name||'',{align:'center',size:szTtd,after:0,b:true})+para('NIP. '+(k.nip||''),{align:'center',size:szTtd,after:0,b:bTtd});
  sigTbl+=tr(tcNB(contentW,kepalaContent,{colspan:4}));
  sigTbl+='</w:tbl>';
  body+=sigTbl+emptyPara();

  // Dokumentasi kegiatan.
  body+=para('DOKUMENTASI KEGIATAN',{b:true,size:szDok,after:120,align:'left'});
  const photos=d.photos||[]; const cc=d.collage||{template:'auto',ratio:'1:1',gap:8};
  if(photos.length){
    let photoTbl='';
    const addPhotoRow=async (items,cols,firstFull=false)=>{
      const pw=Math.round(contentW/cols);
      if(firstFull){
        const p=items[0]; const rel=await addMedia(p.url); let cellXml='';
        const wEmu=contentW/CM_TO_TWIP*CM_TO_EMU; const ratio=(cc.ratio||'1:1').split(':'); const hEmu=wEmu*(Number(ratio[1]||1)/Number(ratio[0]||1));
        if(rel) cellXml=`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${inlineImageXml(rel,wEmu,hEmu,docPrCounter++)}</w:p>`;
        if(p.caption) cellXml+=para(p.caption,{align:'center',size:Math.max(16,szDok-4),after:0});
        photoTbl+=tr(tcNB(contentW,cellXml,{valign:'center',colspan:cols})); return;
      }
      let rowCells='';
      for(let c=0;c<cols;c++){
        const p=items[c]; if(!p){continue;}
        const rel=await addMedia(p.url); let cellXml='';
        const wEmu=Math.max(1,(contentW/cols-CM_TO_TWIP))/CM_TO_TWIP*CM_TO_EMU; const ratio=(cc.ratio||'1:1').split(':'); const hEmu=wEmu*(Number(ratio[1]||1)/Number(ratio[0]||1));
        if(rel) cellXml=`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${inlineImageXml(rel,wEmu,hEmu,docPrCounter++)}</w:p>`;
        else cellXml=para('[gambar tidak dapat dimuat]',{align:'center',size:Math.max(16,szDok-4),after:0});
        if(p.caption) cellXml+=para(p.caption,{align:'center',size:Math.max(16,szDok-4),after:0});
        // In the dynamic six-column table each photo occupies 6/cols grid columns.
        const span = (tblCols===6 && (6%cols===0)) ? 6/cols : 1;
        rowCells+=tcNB(Math.round(contentW/cols),cellXml,{valign:'center',colspan:span});
      }
      photoTbl+=tr(rowCells);
    };
    const t=cc.template||'auto';
    if(t==='single'){for(const p of photos) await addPhotoRow([p],1,false);}
    else if(t==='hero-2'){await addPhotoRow(photos.slice(0,1),2,true);for(let i=1;i<photos.length;i+=2) await addPhotoRow(photos.slice(i,i+2),2,false);}
    let tblCols;
    if(t==='single'){
      tblCols=1; for(const p of photos) await addPhotoRow([p],1,false);
    } else if(t==='hero-2'){
      tblCols=2; await addPhotoRow(photos.slice(0,1),2,true); for(let i=1;i<photos.length;i+=2) await addPhotoRow(photos.slice(i,i+2),2,false);
    } else if(t==='auto'){
      // Dynamic rows: every row spans the complete document width (3+2, 3+3+2, etc.).
      // The six-column grid lets a 2-photo row use 3/6 per cell and a 3-photo row 2/6 per cell.
      tblCols=6; let i=0;
      for(const cols of autoCollageRows(photos.length)) { await addPhotoRow(photos.slice(i,i+cols),cols,false); i+=cols; }
    } else {
      tblCols=(t==='grid-2'||t==='square-2')?2:3;
      const cols=tblCols; for(let i=0;i<photos.length;i+=cols) await addPhotoRow(photos.slice(i,i+cols),cols,false);
    }
    const colWidths=new Array(tblCols).fill(Math.round(contentW/tblCols));
    body+=tableStartNB(colWidths)+photoTbl+'</w:tbl>';
  } else body+=para('(Belum ada foto dokumentasi)',{size:szDok,after:0});

  body+=emptyPara();
  body+=para(kop.puskesmas,{align:'center',b:true,size:32,after:120});
  body+=fieldLine('Hari, Tanggal',[d.hari,d.tanggal?formatTanggalContoh(d.tanggal):''].filter(Boolean).join(' ')||'-', szDok, bDok);
  body+=fieldLine('Kegiatan',d.kegiatan||'-',szDok,bDok);
  // Word contoh memiliki Tujuan di blok dokumentasi; gunakan uraian proses sebagai tujuan kegiatan.
  body+=fieldLine('Tujuan',(d.fields&&d.fields.proses)||d.kegiatan||'-',szDok,bDok);
  body+=fieldLine('Petugas',officersTxt||'-',szDok,bDok);
  body+=fieldLine('Sasaran',(d.fields&&d.fields.sasaran)||'-',szDok,bDok);
  body+=fieldLine('Lokasi',d.lokasi||'-',szDok,bDok);

  const sectPr=`<w:sectPr><w:pgSz w:w="${Math.round(pageWTwip)}" w:h="${Math.round(pageHTwip)}"/><w:pgMar w:top="${Math.round(mT)}" w:right="${Math.round(mR)}" w:bottom="${Math.round(mB)}" w:left="${Math.round(mL)}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  const documentXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}${sectPr}</w:body></w:document>`;
  let relsXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  media.forEach(m=>relsXml+=`<Relationship Id="${m.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.fileName}"/>`);
  relsXml+='</Relationships>';
  const contentTypes=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const stylesXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const coreXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Laporan Perjalanan Dinas</dc:title><dc:creator>${xmlEsc(d.createdByName||'')}</dc:creator></cp:coreProperties>`;
  const zip=new JSZip();
  zip.file('[Content_Types].xml',contentTypes); zip.folder('_rels').file('.rels',rootRels); zip.folder('docProps').file('core.xml',coreXml);
  const wf=zip.folder('word'); wf.file('document.xml',documentXml); wf.file('styles.xml',stylesXml); wf.folder('_rels').file('document.xml.rels',relsXml);
  const mf=wf.folder('media'); media.forEach(m=>mf.file(m.fileName,m.buffer));
  return await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}

async function downloadWord(id){
  const item=LPD_LIST.find(x=>x.id===id) || (DRAFT&&DRAFT.id===id?DRAFT:null);
  if(!item){ toast('Data tidak ditemukan.'); return; }
  toast('Menyiapkan dokumen Word…');
  try{
    await hydrateMedia();
    const blob=await generateDocxBlob(item);
    const fname='LPD_'+(item.kegiatan||'kegiatan').replace(/[^a-zA-Z0-9]+/g,'_').slice(0,40)+'_'+(item.tanggal||'').replace(/-/g,'')+'.docx';
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    toast('Dokumen Word siap diunduh.');
  }catch(e){ console.error(e); toast('Gagal membuat dokumen Word.'); }
}

boot();
