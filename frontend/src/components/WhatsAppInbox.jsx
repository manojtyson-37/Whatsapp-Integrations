import React, { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
let supabase = null;
if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
}

export default function WhatsAppInbox({ backendUrl, workspaceId, userId }) {
  const [conversations, setConversations] = useState({});
  const [activeNumber, setActiveNumber] = useState(null);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [contactsData, setContactsData] = useState({});
  const [activeTab, setActiveTab] = useState('All'); // 'All', 'Assigned to me', 'Lead', 'Customer', 'Spam'
  const [selectedFile, setSelectedFile] = useState(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState(null);
  const [team, setTeam] = useState([]);
  const [internalNotes, setInternalNotes] = useState([]);
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);
  const [editContactName, setEditContactName] = useState('');
  const [editContactEmail, setEditContactEmail] = useState('');
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Fetch initial conversations and contacts
  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    const fetchMessages = async () => {
      if (!workspaceId) return;
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });
      
      if (!error && data) {
        const grouped = groupMessages(data);
        setConversations(grouped);
      }
      setLoading(false);
    };

    const fetchContacts = async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('workspace_id', workspaceId);
      if (!error && Array.isArray(data)) {
        const contactMap = {};
        data.forEach(c => contactMap[c.phone_number] = c);
        setContactsData(contactMap);
      } else {
        console.error("Failed to load contacts or data is not array", error, data);
      }
    };

    const fetchTeam = async () => {
      try {
        const res = await fetch(`${backendUrl}/api/workspaces/team?workspace_id=${workspaceId}`);
        const data = await res.json();
        if (Array.isArray(data)) {
          setTeam(data);
        } else {
          console.error("Team API returned non-array:", data);
          setTeam([]);
        }
      } catch (e) {
        console.error("Failed to load team", e);
        setTeam([]);
      }
    };

    fetchMessages();
    fetchContacts();
    fetchTeam();

    // Subscribe to real-time inserts
    const channel = supabase
      .channel('public:messages')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          setConversations((prev) => {
            const msg = payload.new;
            const existing = prev[msg.phone_number] || [];
            return {
              ...prev,
              [msg.phone_number]: [...existing, msg]
            };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          setConversations((prev) => {
            const msg = payload.new;
            const existing = prev[msg.phone_number] || [];
            const updated = existing.map(m => m.id === msg.id ? msg : m);
            return {
              ...prev,
              [msg.phone_number]: updated
            };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages' },
        (payload) => {
          setConversations((prev) => {
            const newConvos = { ...prev };
            for (const phone in newConvos) {
              newConvos[phone] = newConvos[phone].filter(m => m.id !== payload.old.id);
              if (newConvos[phone].length === 0) delete newConvos[phone];
            }
            return newConvos;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  // Fetch internal notes when activeNumber changes
  useEffect(() => {
    if (!activeNumber) {
      setInternalNotes([]);
      return;
    }
    const fetchNotes = async () => {
      try {
        const res = await fetch(`${backendUrl}/api/contacts/${activeNumber}/notes?workspace_id=${workspaceId}`);
        const data = await res.json();
        if (Array.isArray(data)) setInternalNotes(data);
      } catch (e) {
        console.error("Failed to fetch notes", e);
      }
    };
    fetchNotes();
  }, [activeNumber, workspaceId, backendUrl]);

  const groupMessages = (messages) => {
    const grouped = {};
    messages.forEach(msg => {
      if (!grouped[msg.phone_number]) grouped[msg.phone_number] = [];
      grouped[msg.phone_number].push(msg);
    });
    return grouped;
  };

  const getProfileName = (num) => {
    if (contactsData[num] && contactsData[num].name) {
      return contactsData[num].name;
    }
    const msgs = conversations[num] || [];
    const inboundMsgs = msgs.filter(m => m.direction === 'inbound' && m.profile_name);
    if (inboundMsgs.length > 0) {
      return inboundMsgs[inboundMsgs.length - 1].profile_name;
    }
    return null;
  };

  const handleSendReply = async () => {
    if (!activeNumber || (!replyText.trim() && !selectedFile)) return;
    setSending(true);
    try {
      if (isInternalNote) {
        if (!replyText.trim()) {
           alert("Notes must contain text");
           setSending(false);
           return;
        }
        await fetch(`${backendUrl}/api/contacts/${activeNumber}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId, author_id: userId, note_text: replyText })
        });
        const res = await fetch(`${backendUrl}/api/contacts/${activeNumber}/notes?workspace_id=${workspaceId}`);
        setInternalNotes(await res.json());
        setReplyText('');
        clearFile();
      } else {
        const formData = new FormData();
        formData.append('phoneNumber', activeNumber);
        formData.append('workspace_id', workspaceId);
        if (replyText.trim()) formData.append('message', replyText);
        if (selectedFile) formData.append('file', selectedFile);

        const res = await fetch(`${backendUrl}/api/whatsapp/send`, {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (data.success) {
           setReplyText('');
           clearFile();
        } else {
           alert('Error sending reply: ' + (data.error?.message || 'Unknown error'));
        }
      }
    } catch (e) {
      alert('Error sending: ' + e.message);
    } finally {
      setSending(false);
    }
  };

  const handleSendLocation = async (lat, lng, name, address) => {
    if (!activeNumber) return;
    setSending(true);
    setShowAttachMenu(false);
    try {
      const formData = new FormData();
      formData.append('phoneNumber', activeNumber);
      formData.append('workspace_id', workspaceId);
      formData.append('messageType', 'location');
      formData.append('location', JSON.stringify({ latitude: lat, longitude: lng, name, address }));
      
      const res = await fetch(`${backendUrl}/api/whatsapp/send`, { method: 'POST', body: formData });
      if (!res.ok) alert('Failed to send location');
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      setSending(false);
    }
  };

  const handleSendQuickReplies = async (bodyText, buttonTexts) => {
    if (!activeNumber || !bodyText || buttonTexts.length === 0) return;
    setSending(true);
    setShowAttachMenu(false);
    try {
      const interactive = {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttonTexts.map((text, i) => ({
            type: 'reply',
            reply: { id: `btn_${i}`, title: text.substring(0, 20) }
          }))
        }
      };
      const formData = new FormData();
      formData.append('phoneNumber', activeNumber);
      formData.append('workspace_id', workspaceId);
      formData.append('messageType', 'interactive');
      formData.append('interactive', JSON.stringify(interactive));
      
      const res = await fetch(`${backendUrl}/api/whatsapp/send`, { method: 'POST', body: formData });
      if (!res.ok) alert('Failed to send quick replies');
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      setSending(false);
    }
  };

  const handleAssign = async (assigned_to) => {
    if (!activeNumber) return;
    const value = assigned_to || null;
    setContactsData(prev => ({ 
      ...prev, 
      [activeNumber]: { ...prev[activeNumber], assigned_to: value } 
    }));
    await fetch(`${backendUrl}/api/contacts/${activeNumber}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, assigned_to: value })
    });
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1 || items[i].type === 'application/pdf') {
        const file = items[i].getAsFile();
        if (file) {
          setSelectedFile(file);
          setFilePreviewUrl(URL.createObjectURL(file));
          e.preventDefault();
        }
      }
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setFilePreviewUrl(URL.createObjectURL(file));
    }
  };

  const clearFile = () => {
    setSelectedFile(null);
    setFilePreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDeleteMessage = async (msgId) => {
    if (!confirm('Are you sure you want to delete this message? This only deletes it from your dashboard.')) return;
    try {
      const res = await fetch(`${backendUrl}/api/messages/${msgId}?workspace_id=${workspaceId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete message');
      // Optimistically remove from UI or wait for realtime subscription to catch it
    } catch (e) {
      alert(e.message);
    }
  };

  const handleDeleteChat = async () => {
    if (!activeNumber) return;
    if (!confirm('Are you sure you want to delete this entire conversation?')) return;
    try {
      const res = await fetch(`${backendUrl}/api/contacts/${activeNumber}/messages?workspace_id=${workspaceId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete conversation');
      setActiveNumber(null);
    } catch (e) {
      alert(e.message);
    }
  };

  const handleCategoryChange = async (newCategory) => {
    if (!activeNumber) return;
    setContactsData(prev => ({ 
      ...prev, 
      [activeNumber]: { ...prev[activeNumber], category: newCategory } 
    }));
    
    try {
      const res = await fetch(`${backendUrl}/api/contacts/${activeNumber}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, category: newCategory })
      });
      if (!res.ok) throw new Error('Error updating category.');
    } catch (error) {
      alert(error.message);
    }
  };

  const handleSaveContact = async () => {
    if (!activeNumber) return;
    try {
      const res = await fetch(`${backendUrl}/api/contacts/${activeNumber}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          workspace_id: workspaceId, 
          name: editContactName,
          email: editContactEmail
        })
      });
      if (!res.ok) throw new Error('Failed to save contact');
      
      setContactsData(prev => ({
        ...prev,
        [activeNumber]: {
          ...(prev[activeNumber] || {}),
          name: editContactName,
          email: editContactEmail
        }
      }));
      setIsContactModalOpen(false);
      toast.success('Contact saved successfully!');
    } catch (error) {
      toast.error(error.message);
    }
  };

  if (!supabase) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center text-red-400 max-w-md mx-auto mt-20">
        <p>Supabase is not configured.</p>
      </div>
    );
  }

  const allContacts = Object.keys(conversations);
  
  const contacts = allContacts.filter(num => {
    if (activeTab === 'All') return true;
    if (activeTab === 'Assigned to me') {
       return contactsData[num]?.assigned_to === userId;
    }
    const cat = contactsData[num]?.category || 'Lead';
    return cat === activeTab;
  });

  const activeMessages = activeNumber ? conversations[activeNumber] : [];
  const interleaved = [...activeMessages, ...internalNotes].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  useEffect(() => {
    scrollToBottom();
  }, [interleaved]);

  return (
    <div className="bg-white rounded-2xl flex h-[700px] overflow-hidden border border-gray-200 shadow-sm relative z-10">
      <div className="w-1/3 border-r border-gray-200 flex flex-col bg-[#f9f9fa]">
        <div className="p-5 font-semibold border-b border-gray-200 bg-white/80 backdrop-blur-md z-10">
          <div className="flex gap-2 overflow-x-auto pb-3 mb-3 border-b border-gray-100 hide-scrollbar">
            {['All', 'Assigned to me', 'Lead', 'Customer', 'Spam'].map(tab => (
              <button 
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-200 ${
                  activeTab === tab 
                    ? 'bg-blue-600 text-white shadow-sm' 
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <span className="text-gray-900 text-lg tracking-tight">Conversations</span>
        </div>
        <div className="overflow-y-auto flex-1 custom-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
            </div>
          ) : contacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-gray-400">
              <p className="text-sm">No conversations yet</p>
            </div>
          ) : (
            contacts.map((num) => {
              const name = getProfileName(num);
              const isActive = activeNumber === num;
              const assigneeId = contactsData[num]?.assigned_to;
              const assignee = team.find(t => t.id === assigneeId);
              
              return (
                <div 
                  key={num}
                  onClick={() => setActiveNumber(num)}
                  className={`p-4 cursor-pointer transition-all border-l-4 ${
                    isActive 
                      ? 'bg-blue-50/50 border-blue-500' 
                      : 'border-transparent hover:bg-gray-50'
                  }`}
                >
                  <div className={`font-medium flex justify-between ${isActive ? 'text-gray-900' : 'text-gray-700'}`}>
                    <span className="truncate pr-2">{name || `+${num}`}</span>
                    {assignee && <span className="text-[10px] bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full whitespace-nowrap">{assignee.full_name || 'Agent'}</span>}
                  </div>
                  {contactsData[num]?.tags && contactsData[num].tags.length > 0 && (
                    <div className="flex gap-1 mt-1 overflow-hidden">
                      {contactsData[num].tags.map(t => (
                        <span key={t} className="text-[9px] px-1.5 py-0.5 bg-gray-100 border border-gray-200 text-gray-500 rounded truncate">{t}</span>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-gray-500 truncate mt-1.5 flex items-center gap-1.5">
                    {conversations[num][conversations[num].length - 1]?.content || 'Media Message'}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="w-2/3 flex flex-col bg-white relative">
        {activeNumber ? (
          <>
            <div className="p-4 font-semibold border-b border-gray-200 bg-white/90 backdrop-blur-md z-10 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => {
                    setEditContactName(contactsData[activeNumber]?.name || '');
                    setEditContactEmail(contactsData[activeNumber]?.email || '');
                    setIsContactModalOpen(true);
                  }}
                  className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 border border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-all cursor-pointer shadow-sm active:scale-95"
                  title={contactsData[activeNumber]?.name ? "Edit Contact" : "Save Contact"}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
                </button>
                <div className="flex flex-col">
                  <div className="text-gray-900 text-lg font-medium flex items-center gap-2 leading-none">
                    {getProfileName(activeNumber) || `+${activeNumber}`}
                    <button 
                      onClick={() => {
                        setEditContactName(contactsData[activeNumber]?.name || '');
                        setEditContactEmail(contactsData[activeNumber]?.email || '');
                        setIsContactModalOpen(true);
                      }}
                      className="text-gray-400 hover:text-blue-500 p-1"
                      title={contactsData[activeNumber]?.name ? "Edit Contact" : "Save Contact"}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                    </button>
                    {contactsData[activeNumber]?.tags?.map(t => (
                      <span key={t} className="text-[10px] px-2 py-0.5 bg-gray-100 border border-gray-200 text-gray-600 rounded-full font-medium">{t}</span>
                    ))}
                  </div>
                  {getProfileName(activeNumber) && (
                    <div className="text-sm text-gray-500 mt-1">
                      +{activeNumber}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative flex items-center bg-purple-50 rounded-lg px-2 border border-purple-200 text-sm">
                  <span className="text-purple-600 font-medium px-2 py-1">Assignee:</span>
                  <select 
                    value={contactsData[activeNumber]?.assigned_to || ''}
                    onChange={(e) => handleAssign(e.target.value)}
                    className="appearance-none bg-transparent py-2 pr-6 pl-1 text-gray-700 focus:outline-none cursor-pointer"
                  >
                    <option value="">Unassigned</option>
                    {team.map(t => (
                      <option key={t.id} value={t.id}>{t.full_name || t.auth_email?.email || 'Agent'}</option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-purple-400">
                    <svg className="fill-current h-4 w-4" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
                  </div>
                </div>

                <div className="relative">
                  <select 
                    value={contactsData[activeNumber]?.category || 'Lead'}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    className="appearance-none bg-gray-50 border border-gray-200 rounded-lg px-4 py-2 pr-8 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 hover:bg-gray-100 transition-colors cursor-pointer"
                  >
                    <option value="Lead" className="bg-white">Lead</option>
                    <option value="Customer" className="bg-white">Customer</option>
                    <option value="Spam" className="bg-white">Spam</option>
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-400">
                    <svg className="fill-current h-4 w-4" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
                  </div>
                </div>
                <button 
                  onClick={handleDeleteChat}
                  className="p-2 text-gray-400 hover:text-red-500 hover:bg-gray-50 rounded-lg transition-colors"
                  title="Delete Entire Chat"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 z-10 custom-scrollbar">
              {interleaved.map((msg, idx) => {
                if (msg.note_text !== undefined) {
                  // Internal Note Rendering
                  return (
                    <div key={`note-${idx}`} className="flex flex-col items-center group my-4">
                      <div className="bg-yellow-100 text-yellow-800 border border-yellow-200 rounded-xl px-4 py-3 max-w-[80%] shadow-sm relative text-sm">
                        <div className="font-semibold mb-1 text-yellow-900 flex items-center gap-2">
                           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                           Internal Note • {msg.author?.full_name || 'Agent'}
                        </div>
                        <div className="whitespace-pre-wrap">{msg.note_text}</div>
                        <div className="text-[10px] text-yellow-700 mt-2 text-right opacity-70">
                          {new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </div>
                      </div>
                    </div>
                  );
                }

                const isInbound = msg.direction === 'inbound';
                let docFilename = 'Document';
                let docCaption = msg.content;
                let locationCoords = null;
                let locationName = null;

                if (msg.type === 'document' && msg.content && msg.content.startsWith('[FILENAME]')) {
                  const match = msg.content.match(/^\[FILENAME\](.*?)\[\/FILENAME\]([\s\S]*)$/);
                  if (match) {
                    docFilename = match[1] || 'Document';
                    docCaption = match[2]?.trim() || '';
                  }
                } else if (msg.type === 'location' && msg.content && msg.content.startsWith('[LOCATION]')) {
                  const match = msg.content.match(/^\[LOCATION\]\s*([^-\n]+)(?:-\s*(.*))?$/);
                  if (match) {
                    locationCoords = match[1]?.trim();
                    locationName = match[2]?.trim();
                  }
                }

                const renderMedia = () => {
                  if (!msg.media_id) return null;
                  
                  const isUrl = msg.media_id.startsWith('http');
                  const mediaSrc = isUrl ? msg.media_id : `${backendUrl}/api/whatsapp/media/${msg.media_id}`;

                  if (msg.type === 'document') {
                    return (
                      <a 
                        href={isUrl ? msg.media_id : `${backendUrl}/api/whatsapp/media/${msg.media_id}?workspace_id=${workspaceId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 p-3 bg-black/5 rounded-xl mb-2 mt-1 hover:bg-black/10 transition-colors"
                      >
                        <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center text-red-500 shadow-sm">
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium truncate ${isInbound ? 'text-gray-900' : 'text-white'}`}>{docFilename}</p>
                          <p className={`text-xs truncate ${isInbound ? 'text-gray-500' : 'text-blue-200'}`}>Click to open</p>
                        </div>
                      </a>
                    );
                  } else if (msg.type === 'video') {
                    return (
                      <video 
                        src={mediaSrc} 
                        controls 
                        className="max-w-[280px] max-h-[280px] rounded-xl object-contain mb-2 mt-1 bg-black/5"
                      />
                    );
                  } else if (msg.type === 'audio') {
                    return (
                      <audio 
                        src={mediaSrc} 
                        controls 
                        className="max-w-[280px] mb-2 mt-1"
                      />
                    );
                  } else {
                    return (
                      <img 
                        src={mediaSrc} 
                        alt="Media" 
                        className="max-w-[240px] max-h-[240px] rounded-xl object-contain mb-2 mt-1 bg-black/5" 
                      />
                    );
                  }
                };

                return (
                  <div key={idx} className={`flex flex-col ${isInbound ? 'items-start' : 'items-end'} group`}>
                    <div className="flex items-end gap-2 max-w-[75%]">
                      {!isInbound && (
                        <button onClick={() => handleDeleteMessage(msg.id)} className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-500 transition-all bg-gray-50 rounded-full mb-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                      )}
                      
                      <div className={`relative px-4 py-2.5 shadow-sm ${
                        isInbound 
                          ? 'bg-[#f0f0f0] text-gray-900 rounded-2xl rounded-bl-sm' 
                          : 'bg-blue-600 text-white rounded-2xl rounded-br-sm'
                      }`}>
                        {renderMedia()}
                        {msg.type === 'location' ? (
                          <div className="flex flex-col gap-2">
                            <a 
                              href={`https://maps.google.com/?q=${locationCoords}`} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 p-3 bg-black/5 rounded-xl hover:bg-black/10 transition-colors"
                            >
                              <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center text-red-500 shadow-sm shrink-0">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className={`text-sm font-medium ${isInbound ? 'text-gray-900' : 'text-white'}`}>{locationName || 'Shared Location'}</p>
                                <p className={`text-xs truncate ${isInbound ? 'text-gray-500' : 'text-blue-200'}`}>{locationCoords}</p>
                              </div>
                            </a>
                          </div>
                        ) : msg.type === 'interactive' && msg.content?.startsWith('[BUTTON]') ? (
                          <div className="flex items-center gap-2 bg-blue-50 text-blue-700 px-3 py-2 rounded-lg border border-blue-100">
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"></path></svg>
                             <span className="font-medium text-sm">Tapped: {msg.content.replace('[BUTTON]', '').trim()}</span>
                          </div>
                        ) : msg.type === 'interactive' && msg.content?.startsWith('[LIST]') ? (
                          <div className="flex items-center gap-2 bg-purple-50 text-purple-700 px-3 py-2 rounded-lg border border-purple-100">
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"></path></svg>
                             <span className="font-medium text-sm">Selected: {msg.content.replace('[LIST]', '').trim()}</span>
                          </div>
                        ) : msg.type === 'document' ? (
                          docCaption && <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{docCaption}</p>
                        ) : msg.content?.startsWith('[unsupported]') ? (
                             <div className="flex items-center gap-2 text-gray-500 bg-gray-50 p-2 rounded-lg border border-gray-200 opacity-80">
                               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                               <span className="font-medium text-xs">{msg.content.replace('[unsupported]', '').trim() || 'Unsupported message type (e.g. poll, call, or reaction)'}</span>
                             </div>
                        ) : (
                          msg.content && <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                        )}
                        <div className={`flex justify-end items-center mt-1 gap-1.5 ${isInbound ? 'text-gray-500' : 'text-blue-200'}`}>
                          <span className="text-[10px] font-medium tracking-wide">
                            {new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                          </span>
                          {!isInbound && (
                            <span className="text-[11px]">
                              {msg.status === 'read' ? (
                                <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 13l4 4L19 7M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/><path d="M10 13l4 4L24 7" strokeLinecap="round" strokeLinejoin="round" className="opacity-50"/></svg>
                              ) : msg.status === 'delivered' ? (
                                <svg className="w-3.5 h-3.5 text-blue-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              ) : (
                                <svg className="w-3 h-3 text-blue-200/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      {isInbound && (
                        <button onClick={() => handleDeleteMessage(msg.id)} className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-500 transition-all bg-gray-50 rounded-full mb-1">
                           <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
            
            {/* Chat Input */}
            <div className={`p-5 z-10 border-t border-gray-100 flex flex-col gap-3 transition-colors ${isInternalNote ? 'bg-yellow-50/50' : 'bg-white'}`}>
              <div className="flex items-center gap-4 px-1 mb-1">
                 <label className="flex items-center gap-2 text-sm font-medium cursor-pointer text-gray-600 hover:text-gray-900 transition-colors">
                    <input 
                      type="checkbox" 
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500" 
                      checked={isInternalNote}
                      onChange={(e) => setIsInternalNote(e.target.checked)}
                    />
                    Add Internal Note
                 </label>
                 {isInternalNote && <span className="text-xs text-yellow-600 bg-yellow-100 px-2 py-0.5 rounded-md font-medium">Only visible to your team</span>}
              </div>

              {filePreviewUrl && !isInternalNote && (
                <div className="relative inline-block w-24 h-24 bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
                  <button 
                    onClick={clearFile}
                    className="absolute top-1 right-1 bg-black/50 hover:bg-black/70 text-white rounded-full p-1 z-10 transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                  </button>
                  {selectedFile?.type?.includes('pdf') || selectedFile?.type?.includes('document') ? (
                     <div className="w-full h-full flex items-center justify-center bg-gray-50 text-gray-400 flex-col">
                        <svg className="w-8 h-8 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                        <span className="text-[10px] truncate w-20 text-center px-1 font-medium">{selectedFile.name}</span>
                     </div>
                  ) : (
                    <img src={filePreviewUrl} alt="Preview" className="w-full h-full object-cover" />
                  )}
                </div>
              )}
              
              <form onSubmit={(e) => { e.preventDefault(); handleSendReply(); }} className="flex gap-3 items-end">
                {!isInternalNote && (
                  <>
                    <input 
                      type="file" 
                      className="hidden" 
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      accept="image/*,application/pdf"
                    />
                    <div className="relative">
                      <button 
                        type="button"
                        onClick={() => setShowAttachMenu(!showAttachMenu)}
                        className="p-3.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-colors flex-shrink-0 mb-0.5"
                        title="Attachment Options"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                      </button>
                      
                      {showAttachMenu && (
                        <div className="absolute bottom-full left-0 mb-2 w-48 bg-white rounded-xl shadow-lg border border-gray-100 py-2 z-20 flex flex-col overflow-hidden">
                          <button 
                            type="button" 
                            onClick={() => { setShowAttachMenu(false); fileInputRef.current?.click(); }}
                            className="text-left px-4 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm text-gray-700"
                          >
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                            Image or Document
                          </button>
                          <button 
                            type="button" 
                            onClick={() => {
                              setShowAttachMenu(false);
                              toast('WhatsApp Catalogs must be configured in Meta Business Manager first.', { icon: '🛒' });
                            }}
                            className="text-left px-4 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm text-gray-700"
                          >
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg>
                            Product Catalog
                          </button>
                          <button 
                            type="button" 
                            onClick={() => {
                              const lat = prompt("Enter Latitude:");
                              if (!lat) return;
                              const lng = prompt("Enter Longitude:");
                              if (!lng) return;
                              const name = prompt("Enter Location Name:");
                              handleSendLocation(lat, lng, name, "");
                            }}
                            className="text-left px-4 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm text-gray-700"
                          >
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                            Send Location
                          </button>
                          <button 
                            type="button" 
                            onClick={() => {
                              const title = prompt("Message Text:");
                              if (!title) return;
                              const btns = prompt("Button Texts (comma separated, max 3):");
                              if (!btns) return;
                              handleSendQuickReplies(title, btns.split(',').slice(0,3).map(b => b.trim()));
                            }}
                            className="text-left px-4 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm text-gray-700"
                          >
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"></path></svg>
                            Quick Replies
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
                <div className="flex-1 relative">
                  <input 
                    type="text" 
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onPaste={!isInternalNote ? handlePaste : undefined}
                    placeholder={isInternalNote ? "Write a private note for your team..." : (selectedFile ? "Add a caption..." : "Type your message or paste an image...")} 
                    className={`w-full border rounded-full pl-5 pr-5 py-3 text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-4 transition-all ${isInternalNote ? 'bg-yellow-50 border-yellow-200 focus:border-yellow-300 focus:ring-yellow-500/20' : 'bg-gray-100 border-transparent focus:bg-white focus:border-gray-200 focus:ring-blue-500/10'}`}
                    disabled={sending}
                  />
                </div>
                <button 
                  type="submit"
                  disabled={sending || (!replyText.trim() && !selectedFile)}
                  className={`${isInternalNote ? 'bg-yellow-500 hover:bg-yellow-600 text-yellow-950' : 'bg-blue-600 hover:bg-blue-500 text-white'} rounded-full px-6 py-3 font-medium disabled:opacity-50 transition-all flex items-center gap-2 shadow-sm active:scale-95 flex-shrink-0`}
                >
                  {sending ? (
                    <div className={`w-5 h-5 border-2 border-t-transparent rounded-full animate-spin ${isInternalNote ? 'border-yellow-900/30' : 'border-white/30'}`}></div>
                  ) : (
                    <>
                      <span>{isInternalNote ? 'Save Note' : 'Send'}</span>
                      {!isInternalNote && <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>}
                    </>
                  )}
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 relative z-10 bg-gray-50">
            <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 opacity-50 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
            </div>
            <p className="text-lg text-gray-500 font-medium">Select a conversation</p>
          </div>
        )}
      </div>
      
      {isContactModalOpen && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-xl overflow-hidden border border-gray-100 animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-lg text-gray-900">
                {contactsData[activeNumber]?.name ? "Edit Contact" : "Save Contact"}
              </h3>
              <button onClick={() => setIsContactModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input 
                  type="text" 
                  value={editContactName}
                  onChange={e => setEditContactName(e.target.value)}
                  placeholder="Contact Name"
                  className="w-full border-gray-300 rounded-lg shadow-sm focus:ring-blue-500 focus:border-blue-500 px-4 py-2 border text-gray-900 bg-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input 
                  type="email" 
                  value={editContactEmail}
                  onChange={e => setEditContactEmail(e.target.value)}
                  placeholder="contact@example.com"
                  className="w-full border-gray-300 rounded-lg shadow-sm focus:ring-blue-500 focus:border-blue-500 px-4 py-2 border text-gray-900 bg-white"
                />
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-end gap-3 rounded-b-2xl">
              <button 
                onClick={() => setIsContactModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleSaveContact}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-500 shadow-sm transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
