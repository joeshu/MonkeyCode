package main

import (
 "encoding/base64"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "log"
 "net/http"
 "os"
 "strings"
 "time"

 "github.com/gorilla/websocket"
)

type request struct { ID string `json:"id"`; Content string `json:"content"`; Attachments []map[string]string `json:"attachments"` }
type stream struct { Type string `json:"type"`; Data string `json:"data"` }
type payload struct { Content string `json:"content"`; Attachments []map[string]string `json:"attachments"` }

func main() {
 addr:=env("LISTEN_ADDR",":8091")
 http.HandleFunc("/healthz",func(w http.ResponseWriter,r *http.Request){w.WriteHeader(200);io.WriteString(w,"ok")})
 http.HandleFunc("/api/v1/users/tasks/continue",continueHandler)
 log.Printf("ios continue proxy listening on %s",addr)
 log.Fatal(http.ListenAndServe(addr,nil))
}
func env(k,d string)string{if v:=os.Getenv(k);v!=""{return v};return d}
func continueHandler(w http.ResponseWriter,r *http.Request){
 if r.Method!="POST"{http.Error(w,"method not allowed",405);return}
 var req request
 if err:=json.NewDecoder(io.LimitReader(r.Body,2<<20)).Decode(&req);err!=nil||req.ID==""||strings.TrimSpace(req.Content)==""{http.Error(w,"bad request",400);return}
 cookie:=r.Header.Get("Cookie"); if cookie==""{http.Error(w,"unauthorized",401);return}
 wsURL:=strings.TrimRight(env("BACKEND_WS_BASE","ws://monkeycode-ai-backend:8888"),"/")+"/api/v1/users/tasks/stream?id="+req.ID+"&mode=new"
 h:=http.Header{};h.Set("Cookie",cookie);h.Set("Origin",env("BACKEND_ORIGIN","https://code.69574517.xyz"))
 c,resp,err:=websocket.DefaultDialer.Dial(wsURL,h);if err!=nil{if resp!=nil{http.Error(w,fmt.Sprintf("backend websocket: %s",resp.Status),502)}else{http.Error(w,"backend websocket unavailable",502)};return};defer c.Close()
 c.SetReadDeadline(time.Now().Add(15*time.Second))
 b,_:=json.Marshal(payload{Content:base64.StdEncoding.EncodeToString([]byte(req.Content)),Attachments:req.Attachments})
 msg:=stream{Type:"user-input",Data:base64.StdEncoding.EncodeToString(b)}
 if err:=c.WriteJSON(msg);err!=nil{http.Error(w,"send failed",502);return}
 for i:=0;i<8;i++{_,data,err:=c.ReadMessage();if err!=nil{if errors.Is(err,io.EOF){break};http.Error(w,"backend did not acknowledge",502);return};var got stream;if json.Unmarshal(data,&got)==nil&&got.Type=="user-input"{w.Header().Set("Content-Type","application/json");w.WriteHeader(200);io.WriteString(w,`{"code":0,"message":"success"}`);return}}
 http.Error(w,"backend acknowledgement timeout",504)
}
