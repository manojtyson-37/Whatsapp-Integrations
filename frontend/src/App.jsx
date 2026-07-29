import React, { useState, useEffect } from 'react'
import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from './supabaseClient'
import CampaignDashboard from './components/CampaignDashboard'
import MetaSetupWizard from './components/MetaSetupWizard'
import WhatsAppInbox from './components/WhatsAppInbox'
import ContactManager from './components/ContactManager'
import AutomationManager from './components/AutomationManager'
import BillingDashboard from './components/BillingDashboard'
import TeamSettings from './components/TeamSettings'
import AnalyticsDashboard from './components/AnalyticsDashboard'
import { Toaster } from 'react-hot-toast'
import { Inbox, Users, Send, Settings, ShieldCheck, CreditCard, BarChart } from 'lucide-react'

function App() {
  const [activeTab, setActiveTab] = useState('inbox');
  const [session, setSession] = useState(null);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [userRole, setUserRole] = useState('agent');
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session?.user) {
      setLoadingWorkspace(true);

      const handleInvite = async () => {
        const urlParams = new URLSearchParams(window.location.search);
        const inviteToken = urlParams.get('invite');
        if (inviteToken) {
          try {
            const baseUrl = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '');
            await fetch(`${baseUrl}/api/team/accept`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: inviteToken, userId: session.user.id })
            });
            // Remove token from URL
            window.history.replaceState({}, document.title, window.location.pathname);
          } catch (e) {
            console.error('Failed to accept invite:', e);
          }
        }
      };

      const fetchProfile = async () => {
        await handleInvite();
        
        supabase
          .from('profiles')
          .select('workspace_id, role')
          .eq('id', session.user.id)
          .single()
          .then(async ({ data, error }) => {
            if (data) {
              setWorkspaceId(data.workspace_id);
              setUserRole(data.role || 'agent');
              if (data.workspace_id) {
                const { data: wsData } = await supabase.from('workspaces').select('*').eq('id', data.workspace_id).single();
                if (wsData) {
                  setWorkspace(wsData);
                  if (wsData.subscription_status !== 'active' && wsData.plan_type !== 'free') {
                    setActiveTab('billing');
                  } else if (!wsData.meta_phone_number_id && (data.role === 'admin' || data.role === 'manager')) {
                    setActiveTab('setup');
                  }
                }
              }
            } else if (error) {
              console.error('Error fetching profile:', error.message);
            }
            setLoadingWorkspace(false);
          });
      };

      fetchProfile();
    } else {
      setWorkspaceId(null);
      setWorkspace(null);
      setUserRole('agent');
    }
  }, [session]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (!session) {
    return (
      <div className="min-h-screen bg-[#f5f5f7] flex items-center justify-center p-4 font-sans">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-sm w-full">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">WhatsApp SaaS</h1>
            <p className="text-sm text-gray-500 mt-2">Sign in to access your workspace</p>
          </div>
          <Auth 
            supabaseClient={supabase} 
            appearance={{ theme: ThemeSupa }}
            providers={['google']}
            redirectTo={window.location.origin}
            theme="light"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f7] font-sans">
      <Toaster position="top-right" />
      <nav className="bg-white/80 backdrop-blur-md border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-8">
              <h1 className="text-xl font-semibold text-gray-900 tracking-tight">WhatsApp SaaS</h1>
              <div className="flex gap-1">
                <button 
                  onClick={() => setActiveTab('inbox')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'inbox' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                >
                  <Inbox size={18} />
                  Inbox
                </button>
                <button 
                  onClick={() => setActiveTab('contacts')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'contacts' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                >
                  <Users size={18} />
                  Contacts
                </button>
                {(userRole === 'admin' || userRole === 'manager') && (
                  <>
                    <button 
                      onClick={() => setActiveTab('campaigns')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'campaigns' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                    >
                      <Send size={18} />
                      Campaigns
                    </button>
                    <button 
                      onClick={() => setActiveTab('analytics')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'analytics' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                    >
                      <BarChart size={18} />
                      Analytics
                    </button>
                  </>
                )}
                {userRole === 'admin' && (
                  <>
                    <button 
                      onClick={() => setActiveTab('automation')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'automation' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                    >
                      <Settings size={18} />
                      Automation
                    </button>
                    <button 
                      onClick={() => setActiveTab('team')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'team' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                    >
                      <ShieldCheck size={18} />
                      Team
                    </button>
                    <button 
                      onClick={() => setActiveTab('setup')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'setup' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                    >
                      <Settings size={18} />
                      Setup
                    </button>
                    <button 
                      onClick={() => setActiveTab('billing')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'billing' ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                    >
                      <CreditCard size={18} />
                      Billing
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-500">{session.user.email}</span>
              <button 
                onClick={handleLogout}
                className="text-sm font-medium text-red-600 hover:text-red-500 transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loadingWorkspace ? (
          <div className="text-center py-20">Loading workspace...</div>
        ) : !workspaceId ? (
          <div className="bg-yellow-50 text-yellow-800 p-4 rounded-xl border border-yellow-200">
            <strong>No workspace assigned.</strong> Please contact an administrator to link your account to a workspace.
          </div>
        ) : (
          <>
            {activeTab === 'inbox' && (
              <div>
                <h2 className="text-2xl font-semibold text-gray-900 mb-6 tracking-tight">Live WhatsApp Inbox</h2>
                <WhatsAppInbox 
                  backendUrl={import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '')} 
                  workspaceId={workspaceId}
                  userId={session.user.id}
                />
              </div>
            )}
            
            {activeTab === 'campaigns' && (userRole === 'admin' || userRole === 'manager') && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-2 md:p-8">
                <CampaignDashboard workspaceId={workspaceId} />
              </div>
            )}

            {activeTab === 'analytics' && (userRole === 'admin' || userRole === 'manager') && (
              <div className="bg-transparent mt-4">
                <AnalyticsDashboard workspaceId={workspaceId} />
              </div>
            )}

            {activeTab === 'contacts' && (
              <div className="mb-6">
                <ContactManager 
                  backendUrl={import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '')} 
                  workspaceId={workspaceId} 
                />
              </div>
            )}

            {activeTab === 'team' && userRole === 'admin' && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-2 md:p-8">
                <TeamSettings workspaceId={workspaceId} />
              </div>
            )}

            {activeTab === 'automation' && userRole === 'admin' && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-2 md:p-8 h-[800px]">
                <AutomationManager workspaceId={workspaceId} />
              </div>
            )}

            {activeTab === 'setup' && userRole === 'admin' && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-6">Meta & Interakt Setup</h2>
                <MetaSetupWizard workspaceId={workspaceId} />
              </div>
            )}

            {activeTab === 'billing' && userRole === 'admin' && (
              <BillingDashboard 
                workspace={workspace} 
                onWorkspaceUpdated={(updated) => setWorkspace(updated)}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default App
