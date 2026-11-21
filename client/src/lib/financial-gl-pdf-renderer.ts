import {loadPdfDependencies} from "@/lib/lazy-report-deps";
import {buildGLPdfPages,type GLExportData} from "@/lib/financial-gl-comparison-export";

/**
 * Renders exactly one bounded slice at a time. No 1000-row canvas is ever made.
 * All pages include provenance in the HTML and sequential footer in the PDF.
 * The caller has already reverified the server fingerprint, and the page builder
 * checks the non-certified/scope/export contract again before rendering.
 */
export async function downloadGLComparisonPaginatedPdf(data:GLExportData,filename:string){
 const pages=buildGLPdfPages(data);
 if(pages.length>250)throw new Error("GL_PDF_TOO_MANY_PAGES");
 const {html2canvas,jsPDF}=await loadPdfDependencies();
 const pdf=new jsPDF({orientation:"landscape",unit:"pt",format:"a4",compress:true});
 const width=pdf.internal.pageSize.getWidth();
 const height=pdf.internal.pageSize.getHeight();
 const margin=22,availWidth=width-margin*2,availHeight=height-64;
 const host=document.createElement("div");
 host.dir="rtl";
 host.style.cssText="position:fixed;left:-30000px;top:0;width:1000px;background:#fff;color:#111;font-family:Tahoma,Arial,sans-serif;z-index:-1";
 document.body.appendChild(host);
 try{
  if(document.fonts?.ready)await document.fonts.ready.catch(()=>undefined);
  for(let i=0;i<pages.length;i++){
   const page=document.createElement("article");
   page.dir="rtl";
   page.style.cssText="box-sizing:border-box;width:1000px;padding:15px;background:#fff;color:#111;font-family:Tahoma,Arial,sans-serif;line-height:1.35";
   page.innerHTML=pages[i];
   page.querySelectorAll<HTMLElement>("td,th").forEach(cell=>{
    cell.style.border="1px solid #9CA8B7";cell.style.padding="4px 6px";
    cell.style.fontSize="11px";cell.style.overflowWrap="anywhere";
   });
   host.replaceChildren(page);
   const canvas=await html2canvas(page,{
    scale:1.3,backgroundColor:"#fff",useCORS:false,
    windowWidth:1000,windowHeight:Math.max(720,page.scrollHeight),
    scrollX:0,scrollY:0,
   });
   const imageHeight=canvas.height*availWidth/canvas.width;
   if(!Number.isFinite(imageHeight)||imageHeight>availHeight)
    throw new Error("GL_PDF_PAGE_EXCEEDS_BOUNDS");
   if(i>0)pdf.addPage();
   pdf.addImage(canvas.toDataURL("image/jpeg",0.9),"JPEG",
    margin,margin,availWidth,imageHeight,undefined,"FAST");
   pdf.setFontSize(8);pdf.setTextColor(75);
   pdf.text("PowerHub · NOT_CERTIFIED · Page "+(i+1)+" / "+pages.length,
    width-margin,height-14,{align:"right"});
   pdf.text("Snapshot "+data.snapshotFingerprint,margin,height-14);
   canvas.width=0;canvas.height=0;
  }
  pdf.setProperties({title:"PowerHub — GL comparison (NOT_CERTIFIED)",creator:"PowerHub"});
  pdf.save(filename);
 }finally{host.remove();}
}
