// Мінімальний макет Google Apps Script API для перевірки логіки поза Google.
function colLetter(c){let s='';while(c>0){const r=(c-1)%26;s=String.fromCharCode(65+r)+s;c=Math.floor((c-1)/26);}return s;}

class Range {
  constructor(sheet,row,col,nr,nc){this.sheet=sheet;this.row=row;this.col=col;this.nr=nr;this.nc=nc;}
  _each(fn){for(let r=0;r<this.nr;r++)for(let c=0;c<this.nc;c++)fn(this.row+r,this.col+c,r,c);}
  getValues(){const o=[];for(let r=0;r<this.nr;r++){const line=[];for(let c=0;c<this.nc;c++)line.push(this.sheet.get(this.row+r,this.col+c));o.push(line);}return o;}
  getValue(){return this.sheet.get(this.row,this.col);}
  getDisplayValues(){return this.getValues().map(r=>r.map(v=>this.sheet.display(v)));}
  getDisplayValue(){return this.sheet.display(this.getValue());}
  setValues(v){if(v.length!==this.nr||v[0].length!==this.nc)throw new Error(`setValues розмір ${v.length}x${v[0].length} != ${this.nr}x${this.nc}`);this._each((R,C,r,c)=>this.sheet.set(R,C,v[r][c]));return this;}
  setValue(v){const m=this.sheet.mergeAt(this.row,this.col);if(m&&(m.row!==this.row||m.col!==this.col)){this.sheet.set(m.row,m.col,v);return this;}this.sheet.set(this.row,this.col,v);return this;}
  getFormulas(){return this.getValues().map(r=>r.map(v=>(typeof v==='string'&&v.startsWith('='))?v:''));}
  getNotes(){const o=[];for(let r=0;r<this.nr;r++){const line=[];for(let c=0;c<this.nc;c++)line.push(this.sheet.notes[`${this.row+r},${this.col+c}`]||'');o.push(line);}return o;}
  setNotes(v){this._each((R,C,r,c)=>{this.sheet.notes[`${R},${C}`]=v[r][c];});return this;}
  clearNote(){this._each((R,C)=>{delete this.sheet.notes[`${R},${C}`];});return this;}
  clearContent(){this._each((R,C)=>this.sheet.set(R,C,''));return this;}
  setNumberFormat(f){this._each((R,C)=>{this.sheet.formats[`${R},${C}`]=f;});return this;}
  setHorizontalAlignment(){return this;} setFontWeight(){return this;} setBackground(){return this;}
  getCell(r,c){return new Range(this.sheet,this.row+r-1,this.col+c-1,1,1);}
  isPartOfMerge(){return !!this.sheet.mergeAt(this.row,this.col);}
  getMergedRanges(){const out=[];const seen=new Set();this._each((R,C)=>{const m=this.sheet.mergeAt(R,C);if(m&&!seen.has(m.key)){seen.add(m.key);out.push(new Range(this.sheet,m.row,m.col,m.nr,m.nc));}});return out;}
  merge(){this.breakApart();this.sheet.merges.push({row:this.row,col:this.col,nr:this.nr,nc:this.nc,key:`${this.row},${this.col},${this.nr},${this.nc}`});
    this._each((R,C)=>{if(R!==this.row||C!==this.col)this.sheet.set(R,C,'');});return this;}
  breakApart(){this.sheet.merges=this.sheet.merges.filter(m=>{
      const overlap=!(m.row+m.nr-1<this.row||m.row>this.row+this.nr-1||m.col+m.nc-1<this.col||m.col>this.col+this.nc-1);
      return !overlap;});return this;}
  copyTo(dst,type,transpose){ // тайлимо як Google Sheets
    for(let r=0;r<dst.nr;r++)for(let c=0;c<dst.nc;c++){
      const sv=this.sheet.get(this.row+(r%this.nr),this.col+(c%this.nc));
      if(!type||type==='ALL')dst.sheet.set(dst.row+r,dst.col+c,sv);
    }
    return this;}
}

class Sheet {
  constructor(ss,name,grid,merges){this.ss=ss;this.name=name;this.grid=grid;this.notes={};this.formats={};
    this.merges=(merges||[]).map(m=>({...m,key:`${m.row},${m.col},${m.nr},${m.nc}`}));this.hidden=false;}
  get maxRows(){return this.grid.length;} get maxCols(){return this.grid[0].length;}
  get(r,c){const row=this.grid[r-1];if(!row)return '';const v=row[c-1];return v===undefined?'':v;}
  set(r,c,v){while(this.grid.length<r)this.grid.push(new Array(this.maxCols).fill(''));
    const row=this.grid[r-1];while(row.length<c)row.push('');row[c-1]=v===undefined||v===null?'':v;}
  display(v){if(v instanceof Date)return `${v.getDate()}/${v.getMonth()+1}`;return v===null||v===undefined?'':String(v);}
  mergeAt(r,c){return this.merges.find(m=>r>=m.row&&r<m.row+m.nr&&c>=m.col&&c<m.col+m.nc)||null;}
  getName(){return this.name;} setName(n){this.name=n;return this;}
  getIndex(){return this.ss.sheets.indexOf(this)+1;}
  getMaxRows(){return this.maxRows;} getMaxColumns(){return this.maxCols;}
  getLastRow(){let last=0;for(let r=1;r<=this.maxRows;r++)for(let c=1;c<=this.maxCols;c++)if(this.get(r,c)!=='')last=r;return last;}
  getLastColumn(){let last=0;for(let c=1;c<=this.maxCols;c++)for(let r=1;r<=this.maxRows;r++)if(this.get(r,c)!=='')last=c;return last;}
  getRange(r,c,nr,nc){return new Range(this,r,c,nr===undefined?1:nr,nc===undefined?1:nc);}
  getDataRange(){return new Range(this,1,1,Math.max(this.getLastRow(),1),Math.max(this.getLastColumn(),1));}
  setColumnWidth(){return this;} setFrozenRows(){return this;} hideSheet(){this.hidden=true;return this;}
  appendRow(v){const r=this.getLastRow()+1;v.forEach((x,i)=>this.set(r,i+1,x));return this;}
  insertColumnBefore(c){return this.insertColumnsBefore(c,1);}
  insertColumnsBefore(c,n){
    this.grid.forEach(row=>{while(row.length<this.maxCols)row.push('');row.splice(c-1,0,...new Array(n).fill(''));});
    const shift=(k)=>{const o={};Object.keys(k).forEach(key=>{const[r,cc]=key.split(',').map(Number);o[`${r},${cc>=c?cc+n:cc}`]=k[key];});return o;};
    this.notes=shift(this.notes);this.formats=shift(this.formats);
    this.merges.forEach(m=>{if(m.col>=c)m.col+=n;else if(c>m.col&&c<m.col+m.nc)m.nc+=n;m.key=`${m.row},${m.col},${m.nr},${m.nc}`;});
    return this;}
  deleteColumns(c,n){
    this.grid.forEach(row=>{while(row.length<this.maxCols)row.push('');row.splice(c-1,n);});
    this.merges=this.merges.filter(m=>!(m.col>=c&&m.col+m.nc-1<c+n));
    this.merges.forEach(m=>{if(m.col>=c+n)m.col-=n;m.key=`${m.row},${m.col},${m.nr},${m.nc}`;});
    const shift=(k)=>{const o={};Object.keys(k).forEach(key=>{const[r,cc]=key.split(',').map(Number);if(cc>=c&&cc<c+n)return;o[`${r},${cc>=c+n?cc-n:cc}`]=k[key];});return o;};
    this.notes=shift(this.notes);this.formats=shift(this.formats);
    return this;}
  insertRowAfter(r){this.grid.splice(r,0,new Array(this.maxCols).fill(''));return this;}
  copyTo(ss){const g=this.grid.map(r=>r.slice());
    const s=new Sheet(ss,'Копія '+this.name,g,this.merges.map(m=>({...m})));
    s.notes=Object.assign({},this.notes);s.formats=Object.assign({},this.formats);
    ss.sheets.push(s);return s;}
}

class Spreadsheet {
  constructor(id,name){this.id=id;this.name=name;this.sheets=[];this.active=null;}
  getId(){return this.id;} getSheets(){return this.sheets.slice();}
  getSheetByName(n){return this.sheets.find(s=>s.getName()===n)||null;}
  getActiveSheet(){return this.active||this.sheets[0];}
  setActiveSheet(s){this.active=s;return s;}
  moveActiveSheet(pos){const s=this.active;const i=this.sheets.indexOf(s);this.sheets.splice(i,1);this.sheets.splice(pos-1,0,s);}
  insertSheet(name){const s=new Sheet(this,name,[new Array(30).fill('')],[]);this.sheets.push(s);return s;}
  addSheet(name,grid,merges){const s=new Sheet(this,name,grid,merges);this.sheets.push(s);return s;}
}

const registry={};
global.SpreadsheetApp={
  openById:(id)=>{if(!registry[id])throw new Error('Немає таблиці '+id);return registry[id];},
  getActiveSpreadsheet:()=>global.__ACTIVE_SS__||null,
  CopyPasteType:{PASTE_FORMAT:'FORMAT',PASTE_DATA_VALIDATION:'DV',PASTE_NORMAL:'ALL'},
  getUi:()=>{throw new Error('no ui');}
};
global.__REGISTER_SS__=(ss)=>{registry[ss.getId()]=ss;return ss;};
global.Spreadsheet=Spreadsheet;
global.PropertiesService={getScriptProperties:()=>({getProperties:()=>global.__PROPS__||{}})};
global.MailApp={sendEmail:(o)=>{(global.__MAIL__=global.__MAIL__||[]).push(o);}};
global.Logger={log:(m)=>console.log('LOG:',m)};
global.ScriptApp={getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({everyDays:()=>({atHour:()=>({inTimezone:()=>({create:()=>{}})})})})}),deleteTrigger:()=>{}};
global.HtmlService={createHtmlOutputFromFile:()=>({setTitle:()=>({})})};
global.Utilities={formatDate:(d,tz,fmt)=>{
  const p=(n)=>String(n).padStart(2,'0');
  return fmt.replace('yyyy',d.getFullYear()).replace('dd',p(d.getDate())).replace('MM',p(d.getMonth()+1))
            .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes())).replace('ss',p(d.getSeconds()));}};
module.exports={colLetter};
