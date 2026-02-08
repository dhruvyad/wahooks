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
