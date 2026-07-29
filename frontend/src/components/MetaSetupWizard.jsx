import React, { useState } from 'react';
import axios from 'axios';
import EmbeddedSignup from './EmbeddedSignup';

const MetaSetupWizard = ({ workspaceId }) => {
  const [phoneId, setPhoneId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [status, setStatus] = useState({ type: '', message: '' });
  const [saving, setSaving] = useState(false);
  const [team, setTeam] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  React.useEffect(() => {
    if (!workspaceId) return;
    const backendUrl = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '');
    fetch(`${backendUrl}/api/workspaces/team?workspace_id=${workspaceId}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setTeam(data);
      })
      .catch(console.error);
  }, [workspaceId]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setStatus({ type: '', message: '' });

    try {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '');
      const res = await axios.post(`${backendUrl}/api/workspaces/update`, {
        workspace_id: workspaceId,
        meta_phone_number_id: phoneId,
        meta_waba_id: wabaId,
        meta_access_token: accessToken
      });

      if (res.data.success) {
        setStatus({ type: 'success', message: 'Credentials saved successfully!' });
      }
    } catch (err) {
      console.error(err);
      setStatus({ type: 'error', message: 'Failed to save credentials.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-md overflow-hidden m-4 p-8 border border-gray-200">
      <div className="flex items-center space-x-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-800">Connect WhatsApp</h2>
      </div>

      <div className="mb-8">
        <EmbeddedSignup workspaceId={workspaceId} onSetupComplete={() => setStatus({ type: 'success', message: 'Successfully linked via Meta!' })} />
      </div>

      <div className="text-center mb-6">
        <button 
          onClick={() => setShowAdvanced(!showAdvanced)} 
          className="text-sm text-gray-500 hover:text-gray-700 underline"
        >
          {showAdvanced ? 'Hide Advanced Manual Setup' : 'Need to connect manually? Show Advanced Setup'}
        </button>
      </div>

      {showAdvanced && (
        <div className="space-y-8 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Manual Credential Setup</h3>
            <p className="text-sm text-gray-600 mb-6">Only use this if you have already created a Meta Developer App and System User Token manually.</p>
            
            {status.message && (
              <div className={`mb-4 p-3 rounded text-sm ${status.type === 'success' ? 'bg-green-100 text-green-800 border border-green-200' : 'bg-red-100 text-red-800 border border-red-200'}`}>
                {status.message}
              </div>
            )}
            
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number ID</label>
                <input 
                  type="text" 
                  value={phoneId} 
                  onChange={(e) => setPhoneId(e.target.value)} 
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  placeholder="e.g. 101234567891011"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">WhatsApp Business Account ID (WABA ID)</label>
                <input 
                  type="text" 
                  value={wabaId} 
                  onChange={(e) => setWabaId(e.target.value)} 
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  placeholder="e.g. 101234567891011"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Permanent Access Token</label>
                <input 
                  type="password" 
                  value={accessToken} 
                  onChange={(e) => setAccessToken(e.target.value)} 
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  placeholder="EAAGm0..."
                  required
                />
              </div>
              <button 
                type="submit" 
                disabled={saving || !workspaceId}
                className={`w-full py-2 px-4 rounded-md text-white font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors ${saving ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                {saving ? 'Saving...' : 'Save Credentials'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Workspace Team */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-6 mt-8">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Workspace Team</h3>
        <p className="text-sm text-gray-600 mb-4">These users have access to the Inbox for this workspace.</p>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <ul className="divide-y divide-gray-200">
            {team.length > 0 ? team.map(member => (
              <li key={member.id} className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-sm">
                    {(member.full_name || member.auth_email?.email || '?').charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{member.full_name || 'No Name'}</p>
                    <p className="text-xs text-gray-500">{member.auth_email?.email || 'Unknown Email'}</p>
                  </div>
                </div>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  {member.role || 'Agent'}
                </span>
              </li>
            )) : (
              <li className="p-4 text-sm text-gray-500 text-center">No team members found.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default MetaSetupWizard;
