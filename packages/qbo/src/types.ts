/** The subset of QuickBooks Online entity shapes this app reads (minorversion 75). */
export interface Ref { value: string; name?: string }
export interface MetaData { CreateTime?: string; LastUpdatedTime: string }
export interface QboBase { Id: string; SyncToken: string; MetaData: MetaData; status?: string }

export interface QboCustomer extends QboBase {
  DisplayName: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Balance?: number;
  Active?: boolean;
}

export interface QboItem extends QboBase {
  Name: string;
  Type: string;
  UnitPrice?: number;
  PurchaseCost?: number;
  Active?: boolean;
}

export interface LinkedTxn { TxnId: string; TxnType: string }

export interface SalesLine {
  Id?: string;
  LineNum?: number;
  Description?: string;
  Amount: number;
  DetailType: string; // SalesItemLineDetail | SubTotalLineDetail | DiscountLineDetail | GroupLineDetail | ...
  SalesItemLineDetail?: { ItemRef?: Ref; Qty?: number; UnitPrice?: number };
  LinkedTxn?: LinkedTxn[];
}

export interface QboInvoice extends QboBase {
  CustomerRef: Ref;
  DocNumber?: string;
  TxnDate: string;
  DueDate?: string;
  TotalAmt: number;
  Balance: number;
  Line: SalesLine[];
  LinkedTxn?: LinkedTxn[];
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
}

export interface QboEstimate extends QboBase {
  CustomerRef: Ref;
  DocNumber?: string;
  TxnDate: string;
  ExpirationDate?: string;
  TxnStatus?: string;
  TotalAmt: number;
  Line: SalesLine[];
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
}

export interface QboPayment extends QboBase {
  CustomerRef: Ref;
  TxnDate: string;
  TotalAmt: number;
  UnappliedAmt?: number;
  Line?: Array<{ Amount: number; LinkedTxn?: LinkedTxn[] }>;
}

export interface QboFaultError { Message?: string; Detail?: string; code?: string; element?: string }
export interface QboFault { Fault: { Error: QboFaultError[]; type?: string } }

export type MirrorEntity = 'Customer' | 'Item' | 'Invoice' | 'Estimate' | 'Payment';
