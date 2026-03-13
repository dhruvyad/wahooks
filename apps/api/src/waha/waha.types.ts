export interface WahaSessionResponse {
  name: string;
  status: 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED';
  config?: {
    webhooks?: Array<{
      url: string;
      events: string[];
    }>;
  };
  me?: {
    id: string;
    pushName: string;
  };
}

export interface WahaQrCodeResponse {
  value: string;
  mimetype: string;
}

export interface WahaChatResponse {
  id: string;
  name?: string;
  timestamp: number;
  lastMessage?: { body: string; timestamp: number; fromMe: boolean };
}

export interface WahaMeResponse {
  id: string;
  pushName: string;
}

export interface WahaSendTextResponse {
  id: string;
  timestamp: number;
}
