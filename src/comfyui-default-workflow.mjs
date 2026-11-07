/**
 * 内置默认文生图工作流（ComfyUI **UI 格式**，Qwen-Image 2.1）。
 *
 * 来源：用户在画布里贴过来的 image_qwen_image_2_1_t2i.json（原样内嵌，未做任何改写）。
 * 运行时由 src/comfyui-workflow.mjs 结合 `GET /object_info` 转成 API 格式再提交，
 * 这样用户用的 ComfyUI 版本/自定义节点只要还在，转换就跟着实际节点定义走。
 *
 * 这个文件由 tools 脚本生成：不要手改，改完 ComfyUI 工作流后重新生成即可。
 */

export const DEFAULT_T2I_WORKFLOW_NAME = 'Qwen-Image 2.1 文生图（内置）'

export const DEFAULT_T2I_WORKFLOW = 
{
  "id": "54bb395d-3e60-4c94-b525-85523901575b",
  "revision": 0,
  "last_node_id": 482,
  "last_link_id": 712,
  "nodes": [
    {
      "id": 13,
      "type": "ResolutionSelector",
      "pos": [
        580,
        2750
      ],
      "size": [
        300,
        190
      ],
      "flags": {},
      "order": 0,
      "mode": 0,
      "showAdvanced": false,
      "inputs": [],
      "outputs": [
        {
          "name": "width",
          "type": "INT",
          "links": [
            670
          ]
        },
        {
          "name": "height",
          "type": "INT",
          "links": [
            671
          ]
        }
      ],
      "properties": {
        "Node name for S&R": "ResolutionSelector"
      },
      "widgets_values": [
        "2:3 (Portrait Photo)",
        1,
        8
      ],
      "widgets_values_named": {
        "aspect_ratio": "2:3 (Portrait Photo)",
        "megapixels": 1,
        "multiple": 8
      }
    },
    {
      "id": 459,
      "type": "c291ceec-b98f-4751-9d0b-7bc288f27b30",
      "pos": [
        920,
        2470
      ],
      "size": [
        410,
        610
      ],
      "flags": {},
      "order": 3,
      "mode": 0,
      "inputs": [
        {
          "label": "positive_prompt",
          "name": "prompt",
          "type": "STRING",
          "widget": {
            "name": "prompt"
          },
          "link": null
        },
        {
          "label": "refine_prompt",
          "name": "switch",
          "type": "BOOLEAN",
          "widget": {
            "name": "switch"
          },
          "link": null
        },
        {
          "label": "thinking_mode",
          "name": "thinking",
          "shape": 7,
          "type": "BOOLEAN",
          "widget": {
            "name": "thinking"
          },
          "link": null
        },
        {
          "label": "steps",
          "name": "steps",
          "type": "INT",
          "widget": {
            "name": "steps"
          },
          "link": null
        },
        {
          "name": "width",
          "type": "INT",
          "widget": {
            "name": "width"
          },
          "link": 670
        },
        {
          "name": "height",
          "type": "INT",
          "widget": {
            "name": "height"
          },
          "link": 671
        },
        {
          "label": "sampler",
          "name": "scheduler",
          "type": "COMBO",
          "widget": {
            "name": "scheduler"
          },
          "link": null
        },
        {
          "label": "scheduler",
          "name": "scheduler_1",
          "type": "COMBO",
          "widget": {
            "name": "scheduler_1"
          },
          "link": null
        },
        {
          "label": "PE_model",
          "name": "clip_name_1",
          "type": "COMBO",
          "widget": {
            "name": "clip_name_1"
          },
          "link": null
        },
        {
          "label": "cache_device",
          "name": "device",
          "type": "COMBO",
          "widget": {
            "name": "device"
          },
          "link": null
        },
        {
          "label": "dtype",
          "name": "dtype_1",
          "type": "COMBO",
          "widget": {
            "name": "dtype_1"
          },
          "link": null
        }
      ],
      "outputs": [
        {
          "name": "IMAGE",
          "type": "IMAGE",
          "links": [
            672
          ]
        }
      ],
      "properties": {
        "previewExposures": []
      },
      "widgets_values": [
        "一张竖版角色设定参考图，正面全身立绘，画面上方留白。画面主体是一名二十岁出头的年轻成年女性，身材高挑纤细，成年人比例，不是小孩。她性格元气开朗，身体微微前倾，正侧身转向观者，一只手扬起、指间转着一支细杆黑笔，动作轻快有动势。\n\n她有一头乌黑的长发扎成高高的马尾，马尾随动作向一侧甩起；左侧垂下的发丝里有一缕醒目的薄荷绿挑染，发梢收成笔锋般的尖形。她的眼睛是薄荷绿色虹膜配纸白色瞳孔，眼中有浅薄荷绿的明亮高光，眼神清亮，正看向观者，嘴角张开露出开心的笑容，脸上没有腮红。\n\n她身穿白色交领衬衫，袖子卷到小臂，露出薄荷绿色内衬；外面套一件米白色纸质短马甲，表面带极淡的横向格纹纸纹，前襟有两枚胶囊形圆角扣，左胸别着一枚薄荷绿色胶囊形徽章，上面用细线描出字母 FZ。下身是黑色及膝裙和白色运动鞋，鞋带是薄荷绿色，头上系一根薄荷绿发绳。\n\n她身侧浮空摊开着一本墨黑硬封的小手札，书页发出柔和的纸白微光，页面右上角写着极小的深色数字「001」，封面夹着一条薄荷绿丝带书签正被风吹起。手札旁边有一只由稿纸折成的小纸精灵在半空跳跃，它只在翅膀边缘有一道薄荷绿。\n\n整体配色只用墨黑、纸白、暖白、薄荷绿与淡灰五种颜色，薄荷绿只作为小面积点缀，总面积不超过画面的十分之一。浅色背景，柔和均匀的打光，干净的动漫上色，平涂色块如纸张般清爽，线条清晰，低饱和度，画面明亮通透，不要厚重渲染。不要紫色和紫色渐变，不要霓虹发光，不要深色或黑色背景，不要高饱和撞色，不要写实照片感，不要 3D 渲染，不要 Q 版变形。画面里不出现文字水印和签名。",
        false,
        true,
        "",
        1,
        40,
        1024,
        1024,
        "euler",
        "simple",
        447606998181262,
        "qwen_image_2.1_int8_convrot.safetensors",
        "qwen3vl_8b_int8_convrot.safetensors",
        "qwen_image_2.1_vae_bf16.safetensors",
        "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
        "auto",
        "default"
      ],
      "widgets_values_named": {
        "prompt": "一张竖版角色设定参考图，正面全身立绘，画面上方留白。画面主体是一名二十岁出头的年轻成年女性，身材高挑纤细，成年人比例，不是小孩。她性格元气开朗，身体微微前倾，正侧身转向观者，一只手扬起、指间转着一支细杆黑笔，动作轻快有动势。\n\n她有一头乌黑的长发扎成高高的马尾，马尾随动作向一侧甩起；左侧垂下的发丝里有一缕醒目的薄荷绿挑染，发梢收成笔锋般的尖形。她的眼睛是薄荷绿色虹膜配纸白色瞳孔，眼中有浅薄荷绿的明亮高光，眼神清亮，正看向观者，嘴角张开露出开心的笑容，脸上没有腮红。\n\n她身穿白色交领衬衫，袖子卷到小臂，露出薄荷绿色内衬；外面套一件米白色纸质短马甲，表面带极淡的横向格纹纸纹，前襟有两枚胶囊形圆角扣，左胸别着一枚薄荷绿色胶囊形徽章，上面用细线描出字母 FZ。下身是黑色及膝裙和白色运动鞋，鞋带是薄荷绿色，头上系一根薄荷绿发绳。\n\n她身侧浮空摊开着一本墨黑硬封的小手札，书页发出柔和的纸白微光，页面右上角写着极小的深色数字「001」，封面夹着一条薄荷绿丝带书签正被风吹起。手札旁边有一只由稿纸折成的小纸精灵在半空跳跃，它只在翅膀边缘有一道薄荷绿。\n\n整体配色只用墨黑、纸白、暖白、薄荷绿与淡灰五种颜色，薄荷绿只作为小面积点缀，总面积不超过画面的十分之一。浅色背景，柔和均匀的打光，干净的动漫上色，平涂色块如纸张般清爽，线条清晰，低饱和度，画面明亮通透，不要厚重渲染。不要紫色和紫色渐变，不要霓虹发光，不要深色或黑色背景，不要高饱和撞色，不要写实照片感，不要 3D 渲染，不要 Q 版变形。画面里不出现文字水印和签名。",
        "switch": false,
        "thinking": true,
        "negative_prompt": "",
        "cfg": 1,
        "steps": 40,
        "width": 1024,
        "height": 1024,
        "scheduler": "euler",
        "scheduler_1": "simple",
        "seed": 447606998181262,
        "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
        "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
        "vae_name": "qwen_image_2.1_vae_bf16.safetensors",
        "clip_name_1": "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
        "device": "auto",
        "dtype_1": "default"
      }
    },
    {
      "id": 461,
      "type": "SaveImageAdvanced",
      "pos": [
        1400,
        2470
      ],
      "size": [
        850,
        610
      ],
      "flags": {},
      "order": 4,
      "mode": 0,
      "inputs": [
        {
          "name": "images",
          "type": "IMAGE",
          "link": 672
        }
      ],
      "outputs": [
        {
          "name": "images",
          "type": "IMAGE",
          "links": []
        }
      ],
      "properties": {},
      "widgets_values": [
        "Qwen_image_2.1",
        "png",
        "8-bit",
        "sRGB"
      ],
      "widgets_values_named": {
        "filename_prefix": "Qwen_image_2.1",
        "format": "png",
        "format.bit_depth": "8-bit",
        "format.input_color_space": "sRGB"
      }
    },
    {
      "id": 463,
      "type": "MarkdownNote",
      "pos": [
        -350,
        2470
      ],
      "size": [
        420,
        620
      ],
      "flags": {},
      "order": 1,
      "mode": 0,
      "inputs": [],
      "outputs": [],
      "title": "Note: Model links",
      "properties": {},
      "widgets_values": [
        "Guide: [Subgraph](https://docs.comfy.org/interface/features/subgraph)\n\n## Model Links\n\n- [Hugging Face:Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)\n- [ModelScope:Comfy-Org/Qwen-Image-2.1](https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1)\n\n**diffusion_models**\n\n- [qwen_image_2.1_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors)\n\n**text_encoders**\n\n- [qwen3vl_8b_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors)\n- [qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors)\n\n**vae**\n\n- [qwen_image_2.1_vae_bf16.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors)\n\n\n## Model Storage Location\n\n```\n📂 ComfyUI/\n├── 📂 models/\n│   ├── 📂 diffusion_models/\n│   │   └── qwen_image_2.1_int8_convrot.safetensors\n│   ├── 📂 text_encoders/\n│   │   ├── qwen3vl_8b_int8_convrot.safetensors\n│   │   └── qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors\n│   └── 📂 vae/\n│       └── qwen_image_2.1_vae_bf16.safetensors\n```\n\n## Report Issue\n\nNote: Please update ComfyUI first ([guide](https://docs.comfy.org/installation/update_comfyui)) and prepare required models. Desktop/Cloud updates follow stable releases, so some nightly-supported models may not be available yet.\n\n- Cannot run / runtime errors: [ComfyUI/issues](https://github.com/comfyanonymous/ComfyUI/issues)\n- UI / frontend issues: [ComfyUI_frontend/issues](https://github.com/Comfy-Org/ComfyUI_frontend/issues)\n- Workflow issues: [workflow_templates/issues](https://github.com/Comfy-Org/workflow_templates/issues)\n"
      ],
      "widgets_values_named": {
        "text": "Guide: [Subgraph](https://docs.comfy.org/interface/features/subgraph)\n\n## Model Links\n\n- [Hugging Face:Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)\n- [ModelScope:Comfy-Org/Qwen-Image-2.1](https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1)\n\n**diffusion_models**\n\n- [qwen_image_2.1_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors)\n\n**text_encoders**\n\n- [qwen3vl_8b_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors)\n- [qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors)\n\n**vae**\n\n- [qwen_image_2.1_vae_bf16.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors)\n\n\n## Model Storage Location\n\n```\n📂 ComfyUI/\n├── 📂 models/\n│   ├── 📂 diffusion_models/\n│   │   └── qwen_image_2.1_int8_convrot.safetensors\n│   ├── 📂 text_encoders/\n│   │   ├── qwen3vl_8b_int8_convrot.safetensors\n│   │   └── qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors\n│   └── 📂 vae/\n│       └── qwen_image_2.1_vae_bf16.safetensors\n```\n\n## Report Issue\n\nNote: Please update ComfyUI first ([guide](https://docs.comfy.org/installation/update_comfyui)) and prepare required models. Desktop/Cloud updates follow stable releases, so some nightly-supported models may not be available yet.\n\n- Cannot run / runtime errors: [ComfyUI/issues](https://github.com/comfyanonymous/ComfyUI/issues)\n- UI / frontend issues: [ComfyUI_frontend/issues](https://github.com/Comfy-Org/ComfyUI_frontend/issues)\n- Workflow issues: [workflow_templates/issues](https://github.com/Comfy-Org/workflow_templates/issues)\n"
      },
      "color": "#222",
      "bgcolor": "#000"
    },
    {
      "id": 468,
      "type": "MarkdownNote",
      "pos": [
        100,
        2470
      ],
      "size": [
        420,
        220
      ],
      "flags": {},
      "order": 2,
      "mode": 0,
      "inputs": [],
      "outputs": [],
      "title": "Note: Usage",
      "properties": {},
      "widgets_values": [
        "## Size\nQwen Image 2.1 has native 2K (2048*2048) support for direct output.\n\nOutput size comes from ResolutionSelector (width/height). Default is 1 megapixel (1024*1024). For native 2K, set 1:1 and 4 megapixels (2048*2048). Prefer multiples of 32.\n\n## Transparent Image\n\nTo generate a transparent image, wrap the prompt like this and replace the middle with the subject:\n\n---\nThis is an RGBA format image with transparency. `[your description]`. The image has an alpha channel and a transparent background.\n\n---\nSave as PNG to keep the alpha channel.\n\n## Parameters\n\n- prompt: what to generate. For RGBA, see Note: transparent.\n- negative_prompt: unused while cfg is 1.\n- cfg: keep 1 for the Qwen Image 2.1 official path. Raise it only if you use a negative prompt.\n- steps: Qwen Image 2.1 official  pipeline uses about 40-50 with euler. This template starts at 25. More advanced samplers need fewer steps.\n"
      ],
      "widgets_values_named": {
        "text": "## Size\nQwen Image 2.1 has native 2K (2048*2048) support for direct output.\n\nOutput size comes from ResolutionSelector (width/height). Default is 1 megapixel (1024*1024). For native 2K, set 1:1 and 4 megapixels (2048*2048). Prefer multiples of 32.\n\n## Transparent Image\n\nTo generate a transparent image, wrap the prompt like this and replace the middle with the subject:\n\n---\nThis is an RGBA format image with transparency. `[your description]`. The image has an alpha channel and a transparent background.\n\n---\nSave as PNG to keep the alpha channel.\n\n## Parameters\n\n- prompt: what to generate. For RGBA, see Note: transparent.\n- negative_prompt: unused while cfg is 1.\n- cfg: keep 1 for the Qwen Image 2.1 official path. Raise it only if you use a negative prompt.\n- steps: Qwen Image 2.1 official  pipeline uses about 40-50 with euler. This template starts at 25. More advanced samplers need fewer steps.\n"
      },
      "color": "#222",
      "bgcolor": "#000"
    }
  ],
  "links": [
    [
      670,
      13,
      0,
      459,
      4,
      "INT"
    ],
    [
      671,
      13,
      1,
      459,
      5,
      "INT"
    ],
    [
      672,
      459,
      0,
      461,
      0,
      "IMAGE"
    ]
  ],
  "groups": [],
  "definitions": {
    "subgraphs": [
      {
        "id": "c291ceec-b98f-4751-9d0b-7bc288f27b30",
        "version": 1,
        "state": {
          "lastGroupId": 38,
          "lastNodeId": 482,
          "lastLinkId": 712,
          "lastRerouteId": 9
        },
        "revision": 0,
        "config": {},
        "name": "Text to Image (Qwen Image 2.1)",
        "inputNode": {
          "id": -10,
          "bounding": [
            -660,
            610,
            143.044921875,
            388
          ]
        },
        "outputNode": {
          "id": -20,
          "bounding": [
            1960,
            640,
            128,
            68
          ]
        },
        "inputs": [
          {
            "id": "6a73de3b-f4cd-43a4-9076-76648c6902f0",
            "name": "prompt",
            "type": "STRING",
            "linkIds": [
              684,
              711
            ],
            "localized_name": "prompt",
            "label": "positive_prompt",
            "pos": [
              -540.955078125,
              634
            ]
          },
          {
            "id": "140602e4-2e82-49b4-b1d6-afa99d79a475",
            "name": "switch",
            "type": "BOOLEAN",
            "linkIds": [
              688
            ],
            "label": "refine_prompt",
            "pos": [
              -540.955078125,
              654
            ]
          },
          {
            "id": "e80f9a8b-0a83-40c8-ac0f-cc0bc633ed26",
            "name": "thinking",
            "type": "BOOLEAN",
            "linkIds": [
              695
            ],
            "label": "thinking_mode",
            "pos": [
              -540.955078125,
              674
            ]
          },
          {
            "id": "d4c1377f-7fbc-4519-b83c-9a3b9c2de104",
            "name": "negative_prompt",
            "type": "STRING",
            "linkIds": [
              657
            ],
            "pos": [
              -540.955078125,
              694
            ]
          },
          {
            "id": "420ee896-17c3-4e07-95fc-0ff309a6b836",
            "name": "cfg",
            "type": "FLOAT",
            "linkIds": [
              658
            ],
            "pos": [
              -540.955078125,
              714
            ]
          },
          {
            "id": "349c3f72-ba7a-4277-84ff-8029faa16019",
            "name": "steps",
            "type": "INT",
            "linkIds": [
              659
            ],
            "label": "steps",
            "pos": [
              -540.955078125,
              734
            ]
          },
          {
            "id": "91c96cf8-057b-4da2-b71e-305541a3527e",
            "name": "width",
            "type": "INT",
            "linkIds": [
              660
            ],
            "localized_name": "width",
            "pos": [
              -540.955078125,
              754
            ]
          },
          {
            "id": "661cc520-6bd0-4925-90ec-cecaa188b57d",
            "name": "height",
            "type": "INT",
            "linkIds": [
              661
            ],
            "localized_name": "height",
            "pos": [
              -540.955078125,
              774
            ]
          },
          {
            "id": "9f0e91b8-5a4a-4f5a-a2a4-4ddc180df0fd",
            "name": "scheduler",
            "type": "COMBO",
            "linkIds": [
              662
            ],
            "label": "sampler",
            "pos": [
              -540.955078125,
              794
            ]
          },
          {
            "id": "4710583f-3cb0-4091-87ab-dadd8a2e657c",
            "name": "scheduler_1",
            "type": "COMBO",
            "linkIds": [
              668
            ],
            "label": "scheduler",
            "pos": [
              -540.955078125,
              814
            ]
          },
          {
            "id": "977ce57d-3764-491c-8d2d-543754cfbaf1",
            "name": "seed",
            "type": "INT",
            "linkIds": [
              667,
              697
            ],
            "pos": [
              -540.955078125,
              834
            ]
          },
          {
            "id": "143494fb-a40e-423f-be3b-ecc808b408b0",
            "name": "unet_name",
            "type": "COMBO",
            "linkIds": [
              663
            ],
            "pos": [
              -540.955078125,
              854
            ]
          },
          {
            "id": "d8528289-e121-45ed-9c31-e6370ce4ba5e",
            "name": "clip_name",
            "type": "COMBO",
            "linkIds": [
              664
            ],
            "pos": [
              -540.955078125,
              874
            ]
          },
          {
            "id": "f03d1fb0-d592-4997-b55e-e7a2549c36e5",
            "name": "vae_name",
            "type": "COMBO",
            "linkIds": [
              665
            ],
            "pos": [
              -540.955078125,
              894
            ]
          },
          {
            "id": "e12b2532-5fcd-4f34-9ddd-71df7e5021c5",
            "name": "clip_name_1",
            "type": "COMBO",
            "linkIds": [
              696
            ],
            "label": "PE_model",
            "pos": [
              -540.955078125,
              914
            ]
          },
          {
            "id": "d2597afa-78fa-49f2-96cb-5fda1a3b9eee",
            "name": "device",
            "type": "COMBO",
            "linkIds": [
              703
            ],
            "label": "cache_device",
            "pos": [
              -540.955078125,
              934
            ]
          },
          {
            "id": "ef25ddbe-1463-4c53-9065-93aa867e77ab",
            "name": "dtype_1",
            "type": "COMBO",
            "linkIds": [
              704
            ],
            "label": "dtype",
            "pos": [
              -540.955078125,
              954
            ]
          }
        ],
        "outputs": [
          {
            "id": "f6f3effc-0961-4c17-b52c-a77c16ca6aa4",
            "name": "IMAGE",
            "type": "IMAGE",
            "linkIds": [
              650
            ],
            "localized_name": "IMAGE",
            "pos": [
              1984,
              664
            ]
          }
        ],
        "widgets": [],
        "nodes": [
          {
            "id": 451,
            "type": "UNETLoader",
            "pos": [
              -190,
              410
            ],
            "size": [
              510,
              90
            ],
            "flags": {},
            "order": 1,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "UNet名称",
                "name": "unet_name",
                "type": "COMBO",
                "widget": {
                  "name": "unet_name"
                },
                "link": 663
              }
            ],
            "outputs": [
              {
                "localized_name": "模型",
                "name": "MODEL",
                "type": "MODEL",
                "links": [
                  701
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "UNETLoader",
              "models": [
                {
                  "name": "qwen_image_2.1_int8_convrot.safetensors",
                  "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
                  "directory": "diffusion_models"
                }
              ]
            },
            "widgets_values": [
              "qwen_image_2.1_int8_convrot.safetensors",
              "default"
            ],
            "widgets_values_named": {
              "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
              "weight_dtype": "default"
            }
          },
          {
            "id": 452,
            "type": "TextEncodeQwenImage21",
            "pos": [
              440,
              410
            ],
            "size": [
              530,
              680
            ],
            "flags": {},
            "order": 2,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "clip",
                "name": "clip",
                "type": "CLIP",
                "link": 647
              },
              {
                "localized_name": "image_1",
                "name": "images.image_1",
                "shape": 7,
                "type": "IMAGE",
                "link": null
              },
              {
                "localized_name": "vae",
                "name": "vae",
                "shape": 7,
                "type": "VAE",
                "link": null
              },
              {
                "localized_name": "prompt",
                "name": "prompt",
                "type": "STRING",
                "widget": {
                  "name": "prompt"
                },
                "link": 687
              },
              {
                "localized_name": "negative_prompt",
                "name": "negative_prompt",
                "type": "STRING",
                "widget": {
                  "name": "negative_prompt"
                },
                "link": 657
              }
            ],
            "outputs": [
              {
                "localized_name": "positive",
                "name": "positive",
                "type": "CONDITIONING",
                "links": [
                  653
                ]
              },
              {
                "localized_name": "negative",
                "name": "negative",
                "type": "CONDITIONING",
                "links": [
                  655
                ]
              },
              {
                "localized_name": "latent",
                "name": "latent",
                "type": "LATENT",
                "links": null
              }
            ],
            "properties": {
              "Node name for S&R": "TextEncodeQwenImage21"
            },
            "widgets_values": [
              "",
              "",
              1024
            ],
            "widgets_values_named": {
              "prompt": "",
              "negative_prompt": "",
              "resolution": 1024
            }
          },
          {
            "id": 453,
            "type": "CLIPLoader",
            "pos": [
              -190,
              570
            ],
            "size": [
              510,
              120
            ],
            "flags": {},
            "order": 3,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "CLIP名称",
                "name": "clip_name",
                "type": "COMBO",
                "widget": {
                  "name": "clip_name"
                },
                "link": 664
              }
            ],
            "outputs": [
              {
                "localized_name": "CLIP",
                "name": "CLIP",
                "type": "CLIP",
                "links": [
                  647
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "CLIPLoader",
              "models": [
                {
                  "name": "qwen3vl_8b_int8_convrot.safetensors",
                  "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
                  "directory": "text_encoders"
                }
              ]
            },
            "widgets_values": [
              "qwen3vl_8b_int8_convrot.safetensors",
              "qwen_image",
              "default"
            ],
            "widgets_values_named": {
              "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
              "type": "qwen_image",
              "device": "default"
            }
          },
          {
            "id": 454,
            "type": "VAELoader",
            "pos": [
              -190,
              770
            ],
            "size": [
              510,
              70
            ],
            "flags": {},
            "order": 4,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "vae名称",
                "name": "vae_name",
                "type": "COMBO",
                "widget": {
                  "name": "vae_name"
                },
                "link": 665
              }
            ],
            "outputs": [
              {
                "localized_name": "VAE",
                "name": "VAE",
                "type": "VAE",
                "links": [
                  649
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "VAELoader",
              "models": [
                {
                  "name": "qwen_image_2.1_vae_bf16.safetensors",
                  "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
                  "directory": "vae"
                }
              ]
            },
            "widgets_values": [
              "qwen_image_2.1_vae_bf16.safetensors"
            ],
            "widgets_values_named": {
              "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
            }
          },
          {
            "id": 456,
            "type": "EmptyLatentImage",
            "pos": [
              -70,
              1010
            ],
            "size": [
              300,
              120
            ],
            "flags": {},
            "order": 5,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "宽度",
                "name": "width",
                "type": "INT",
                "widget": {
                  "name": "width"
                },
                "link": 660
              },
              {
                "localized_name": "高度",
                "name": "height",
                "type": "INT",
                "widget": {
                  "name": "height"
                },
                "link": 661
              }
            ],
            "outputs": [
              {
                "localized_name": "Latent",
                "name": "LATENT",
                "type": "LATENT",
                "links": [
                  654
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "EmptyLatentImage"
            },
            "widgets_values": [
              1024,
              1024,
              1
            ],
            "widgets_values_named": {
              "width": 1024,
              "height": 1024,
              "batch_size": 1
            }
          },
          {
            "id": 457,
            "type": "VAEDecode",
            "pos": [
              1620,
              660
            ],
            "size": [
              230,
              60
            ],
            "flags": {},
            "order": 6,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "Latent",
                "name": "samples",
                "type": "LATENT",
                "link": 651
              },
              {
                "localized_name": "vae",
                "name": "vae",
                "type": "VAE",
                "link": 649
              }
            ],
            "outputs": [
              {
                "localized_name": "图像",
                "name": "IMAGE",
                "type": "IMAGE",
                "links": [
                  650
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "VAEDecode"
            }
          },
          {
            "id": 458,
            "type": "KSampler",
            "pos": [
              1180,
              640
            ],
            "size": [
              270,
              270
            ],
            "flags": {},
            "order": 7,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "模型",
                "name": "model",
                "type": "MODEL",
                "link": 700
              },
              {
                "localized_name": "正面条件",
                "name": "positive",
                "type": "CONDITIONING",
                "link": 653
              },
              {
                "localized_name": "负面条件",
                "name": "negative",
                "type": "CONDITIONING",
                "link": 655
              },
              {
                "localized_name": "Latent图像",
                "name": "latent_image",
                "type": "LATENT",
                "link": 654
              },
              {
                "localized_name": "种子",
                "name": "seed",
                "type": "INT",
                "widget": {
                  "name": "seed"
                },
                "link": 667
              },
              {
                "localized_name": "步数",
                "name": "steps",
                "type": "INT",
                "widget": {
                  "name": "steps"
                },
                "link": 659
              },
              {
                "localized_name": "cfg",
                "name": "cfg",
                "type": "FLOAT",
                "widget": {
                  "name": "cfg"
                },
                "link": 658
              },
              {
                "localized_name": "采样器名称",
                "name": "sampler_name",
                "type": "COMBO",
                "widget": {
                  "name": "sampler_name"
                },
                "link": 662
              },
              {
                "localized_name": "调度器",
                "name": "scheduler",
                "type": "COMBO",
                "widget": {
                  "name": "scheduler"
                },
                "link": 668
              }
            ],
            "outputs": [
              {
                "localized_name": "Latent",
                "name": "LATENT",
                "type": "LATENT",
                "links": [
                  651
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "KSampler"
            },
            "widgets_values": [
              0,
              "fixed",
              25,
              1,
              "euler",
              "simple",
              1
            ],
            "widgets_values_named": {
              "seed": 0,
              "control_after_generate": "fixed",
              "steps": 25,
              "cfg": 1,
              "sampler_name": "euler",
              "scheduler": "simple",
              "denoise": 1
            }
          },
          {
            "id": 471,
            "type": "TextGenerate",
            "pos": [
              470,
              -420
            ],
            "size": [
              400,
              460
            ],
            "flags": {},
            "order": 8,
            "mode": 0,
            "showAdvanced": true,
            "inputs": [
              {
                "localized_name": "clip",
                "name": "clip",
                "type": "CLIP",
                "link": 681
              },
              {
                "localized_name": "图像",
                "name": "image",
                "shape": 7,
                "type": "IMAGE",
                "link": null
              },
              {
                "localized_name": "视频",
                "name": "video",
                "shape": 7,
                "type": "IMAGE",
                "link": null
              },
              {
                "localized_name": "音频",
                "name": "audio",
                "shape": 7,
                "type": "AUDIO",
                "link": null
              },
              {
                "localized_name": "system_prompt",
                "name": "system_prompt",
                "shape": 7,
                "type": "STRING",
                "link": 709
              },
              {
                "localized_name": "提示词",
                "name": "prompt",
                "type": "STRING",
                "widget": {
                  "name": "prompt"
                },
                "link": 711
              },
              {
                "localized_name": "种子",
                "name": "sampling_mode.seed",
                "type": "INT",
                "widget": {
                  "name": "sampling_mode.seed"
                },
                "link": 697
              },
              {
                "localized_name": "思考模式",
                "name": "thinking",
                "shape": 7,
                "type": "BOOLEAN",
                "widget": {
                  "name": "thinking"
                },
                "link": 695
              }
            ],
            "outputs": [
              {
                "localized_name": "生成文本",
                "name": "generated_text",
                "type": "STRING",
                "links": [
                  712
                ]
              },
              {
                "localized_name": "thinking",
                "name": "thinking",
                "type": "STRING",
                "links": null
              }
            ],
            "properties": {
              "Node name for S&R": "TextGenerate"
            },
            "widgets_values": [
              "",
              16256,
              "on",
              1,
              20,
              0.95,
              0,
              1.05,
              0,
              0,
              false,
              false,
              "auto"
            ],
            "widgets_values_named": {
              "prompt": "",
              "max_length": 16256,
              "sampling_mode": "on",
              "sampling_mode.temperature": 1,
              "sampling_mode.top_k": 20,
              "sampling_mode.top_p": 0.95,
              "sampling_mode.min_p": 0,
              "sampling_mode.repetition_penalty": 1.05,
              "sampling_mode.seed": 0,
              "sampling_mode.presence_penalty": 0,
              "thinking": false,
              "use_default_template": false,
              "mtp": "auto"
            }
          },
          {
            "id": 472,
            "type": "PreviewAny",
            "pos": [
              990,
              -250
            ],
            "size": [
              470,
              430
            ],
            "flags": {},
            "order": 9,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "源",
                "name": "source",
                "type": "*",
                "link": 686
              }
            ],
            "outputs": [
              {
                "localized_name": "字符串",
                "name": "STRING",
                "type": "STRING",
                "links": [
                  687
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "PreviewAny"
            },
            "widgets_values": [],
            "widgets_values_named": {}
          },
          {
            "id": 473,
            "type": "CLIPLoader",
            "pos": [
              -180,
              -420
            ],
            "size": [
              530,
              120
            ],
            "flags": {},
            "order": 10,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "CLIP名称",
                "name": "clip_name",
                "type": "COMBO",
                "widget": {
                  "name": "clip_name"
                },
                "link": 696
              }
            ],
            "outputs": [
              {
                "localized_name": "CLIP",
                "name": "CLIP",
                "type": "CLIP",
                "links": [
                  681
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "CLIPLoader",
              "models": [
                {
                  "name": "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
                  "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
                  "directory": "text_encoders"
                }
              ]
            },
            "widgets_values": [
              "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
              "stable_diffusion",
              "default"
            ],
            "widgets_values_named": {
              "clip_name": "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
              "type": "stable_diffusion",
              "device": "default"
            }
          },
          {
            "id": 474,
            "type": "ComfySwitchNode",
            "pos": [
              990,
              -420
            ],
            "size": [
              270,
              80
            ],
            "flags": {},
            "order": 11,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "为假时",
                "name": "on_false",
                "shape": 7,
                "type": "STRING",
                "link": 684
              },
              {
                "localized_name": "为真时",
                "name": "on_true",
                "shape": 7,
                "type": "STRING",
                "link": 712
              },
              {
                "localized_name": "切换",
                "name": "switch",
                "type": "BOOLEAN",
                "widget": {
                  "name": "switch"
                },
                "link": 688
              }
            ],
            "outputs": [
              {
                "localized_name": "输出",
                "name": "output",
                "type": "STRING",
                "links": [
                  686
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "ComfySwitchNode"
            },
            "widgets_values": [
              false
            ],
            "widgets_values_named": {
              "switch": false
            }
          },
          {
            "id": 475,
            "type": "PrimitiveStringMultiline",
            "pos": [
              -180,
              -240
            ],
            "size": [
              530,
              270
            ],
            "flags": {},
            "order": 0,
            "mode": 0,
            "inputs": [],
            "outputs": [
              {
                "localized_name": "字符串",
                "name": "STRING",
                "type": "STRING",
                "links": [
                  709
                ]
              }
            ],
            "title": "Text (System Prompt)",
            "properties": {
              "Node name for S&R": "PrimitiveStringMultiline"
            },
            "widgets_values": [
              "<|im_start|>system\n# Image Prompt Rewriting Expert\n\nYou turn a user's image request into one long English paragraph that describes the\nfinished image as if you were looking at it, plus the aspect ratio it should be\nrendered at. You are not talking to the user and not talking to a renderer: you are\nan observer reporting what is in the frame.\n\nWork through the eight steps below in order. Each step commits one decision; later\nsteps never revise an earlier one.\n\n## Step 1 — Read the brief and split it in two\n\nList what the user has fixed and what they have left open.\n\nFixed, and it must survive into your description unchanged: every string of text\nthey want shown, every named object, every count, every stated colour, every stated\nposition, and the aspect ratio if they gave one. Copy their text strings character\nfor character, in their own script, including punctuation and spacing.\n\nA third thing they may give you is an instruction about the job rather than about the\npicture — \"use double quotes\", \"no hard-edged blocks\", \"4K, no noise\", \"make sure the\ntext is sharp\". That is not content. Obey it silently where it applies and never echo\nit: the description states what is in the frame, never what must be done.\n\nOpen, and you must decide it: everything they did not mention. A three-word request\nand a three-hundred-word request both become a description of the same size, so a\nshort brief means you are inventing most of the frame, not writing less.\n\n## Step 2 — Fix the frame\n\nDecide the orientation from the subject, then pick the ratio.\n\nIf the user states a ratio, use it. Otherwise: `3:2` for anything horizontal and\n`2:3` for anything vertical — these are the two defaults and cover most images.\nUse `1:1` for a square badge, icon, album cover or single centred emblem, `16:9`\nfor a wide cinematic or presentation frame, `1:2` or `9:16` for a phone screen or a\ntall standing banner. `3:4`, `2:1`, `21:9`, `4:3`, `9:21`, `4:5`, `3:1`, `5:4`,\n`1:3` exist but only when the subject or the user really calls for them.\n\nThe ratio lives only in the `wh_ratio` field. Never write a ratio, a resolution, or\na pixel count into the description itself.\n\n## Step 3 — Write the opening sentence\n\nOne sentence, around twenty words. Name the medium, the style, the subject, and the\nbackground or palette; usually name the orientation too:\n\n`The image is a ⟨vertical / wide / square / tall⟩ ⟨style⟩ ⟨photograph · poster · illustration · scene · portrait · infographic · close-up · graphic · page · card · sheet · logo⟩ of ⟨subject⟩, ⟨the background and its palette⟩.`\n\n`This is a …` or a bare `A vertical realistic photograph of …` work equally well. The\nmedium noun is the one part that is never omitted.\n\nThe style word goes here — realistic, photorealistic, minimalist, flat-vector,\ncinematic, watercolour, isometric, editorial, hand-drawn, 3D-rendered, retro. Name\nit once here; you may echo it in the closing sentence.\n\n## Step 4 — Inventory before you write\n\nBefore any more prose, settle two lists.\n\nEvery element that will appear, each with a place in the frame: upper-left,\nacross the top, on the far right, in the lower-third, in the centre, in front of,\nbehind, tucked into the corner. You will need eight to fourteen such positional\nphrases, about ten typically, and they must reach the corners, the edges and the\ncentre — not cluster in the middle.\n\nEvery piece of text that will be legible in the image, in reading order.\n\n## Step 5 — Walk the frame\n\nNow describe it in order. Which order depends on how the frame is filled.\n\n**If the frame is divided into regions** — a poster, a page, an interface, a layout, a\nwide scene with several things in it — walk the regions:\n\n1. The background and the surface it sits on — this comes immediately after the\n   opening sentence, not at the end.\n2. The top band: headline, header bar, sky, ceiling, whatever occupies the top edge.\n3. Down and across the body of the frame: left side, then centre, then right side.\n   Give each region one or two sentences.\n4. The bottom band: footer, foreground, ground plane, base row.\n\n**If one subject fills the frame** — a portrait, a close-up, a single object — walk\nthe subject instead: the background and how far it falls off, then the subject's pose\nand where it is placed in the frame, then head and face, then body and each garment or\nsurface, then what is held or touching it, then whatever little is left at the edges.\nKeep using positional phrases inside the subject — in the upper-left of the frame,\nbehind the left shoulder, along the lower edge — so the frame stays locatable.\n\nRoughly a third of your sentences should open on the positional phrase itself —\n\"On the right side of the frame, …\", \"In the upper-left corner, …\", \"Across the\nlower third, …\" — so the reader always knows where they are looking.\n\nKeep it to one paragraph. Break to a new paragraph only when the image is genuinely\nbuilt from stacked regions — panels, cards, sections, slides — and then one\nparagraph per region, each opening on where that region sits.\n\n## Step 6 — Set every piece of text\n\nSkip this step if nothing in the image is meant to be read — a third of images have\nno legible text at all, and inventing signage for them is a mistake.\n\nOtherwise, for each string from your Step 4 list, in reading order, name where it sits,\nwhat it looks like, and what it says: `a bold black headline across the top reads \"…\"`.\n\nPut the string in straight double quotes, in its own script — Chinese, Russian,\nKorean, Japanese and Arabic text stays in Chinese, Russian, Korean, Japanese and\nArabic. Give its weight, colour, case and relative size. Describe a line break as a\nsecond line rather than putting a real newline inside the string. If a mark is not meant\nto be read — distant signage, a label behind glass, dense body copy — call it\nblurred, indistinct, or too small to read rather than inventing letters. If the image contains a chart\nor a table, its axes, tick labels, legend entries, series and cell values are text\ntoo: write them out.\n\n## Step 7 — Give the lighting its own sentence\n\nEvery image has light in it, and the description always accounts for it: the source,\nits direction, its quality, and the shadows and highlights it leaves. Soft diffused\ndaylight from a window on the left, hard overhead studio light, warm low sun, flat\neven ambient light for a diagram.\n\nOnce the contents are placed, give it a sentence of its own — `The lighting is …` —\nor, if the light is what makes a particular surface look the way it does, fold it into\nthat surface's sentence. Either way it is stated explicitly, not left implied.\n\n## Step 8 — Close with the whole frame\n\nEnd on a single sentence that steps back:\n\n`The overall composition ⟨is / uses / feels⟩ …`\n\n`The composition is …`, `The overall design …`, `The overall mood …`, `The overall\npalette …` and `The image has …` are the same move. Cover balance and symmetry, the\npalette, the style, and the mood in that one sentence. Write exactly one such\nsentence — do not follow it with a second summary.\n\n## Throughout\n\n**Size.** The description runs about twenty sentences and four to five hundred words,\nroughly twenty-five words a sentence. That is the same size whether the brief was three\nwords or three hundred: a dense frame with many regions and a lot of text runs longer, a\nsingle quiet subject runs shorter, but a thin brief never buys a thin description.\n\n**Observe, don't instruct.** Present tense, third person, declarative. No \"you\", no\n\"create\", no \"make sure\", no \"the AI should\". No quality boosters — no \"masterpiece\",\n\"8K\", \"highly detailed\", \"award-winning\".\n\n**Hedge what you cannot be certain of.** An observer describing a picture says\n\"appears to be\", \"likely\", \"suggesting\", and offers a pair — \"a notebook\nor a tablet\", \"wood or dark laminate\" — when the thing is genuinely ambiguous. Do\nthis often; it is the natural register here. Be flatly definite only about what the\nuser fixed.\n\n**Name colours with a modifier, almost never bare.** Deep navy, muted olive, pale\ncream, warm terracotta, soft dusty rose, blue-grey, off-white, charcoal, brownish-\ngreen. Hex codes only if the user gave them.\n\n**Give the material, not just the noun.** Brushed metal, matte plastic, glossy\nceramic, coarse linen, weathered wood, frosted glass, grain, scuffs, condensation,\nvisible brush strokes, paper fibre.\n\n**Enumerate; never summarise.** \"Several items\" and \"various decorations\" are not\ndescriptions. Say what each thing is. Write small counts as words — three, five,\ntwelve — and if something is partly hidden, say so and describe the visible part.\n\n**People get their observable surface.** Build, posture, where they are looking,\nexpression, hair, skin tone, and each garment with its colour and material. Age is a\nlife stage or a decade — a child, a teenager, a young adult, middle-aged, elderly,\nin her thirties — never a number of years. If a face is turned away or cropped, say\nthat instead of describing it.\n\n**Objects by class, not by brand.** A silver laptop, a mirrorless camera, a compact\nhatchback — unless the user named the brand. Photographic and design vocabulary is\nwelcome: shallow depth of field, bokeh, backlit, close-up, negative space,\ngrid, drop shadow.\n\n**Everything holds together physically.** Shadows fall away from the light, reflections\nmatch what is in front of the surface, scale is consistent between neighbouring\nobjects, and a surface reacts to what sits on it. If the user asked for something\nimpossible, describe it as the image shows it and let the rest of the scene stay\ncoherent around it.\n\n## Language\n\nThe description is always in English, whatever language the request arrives in. The\nonly exception is text shown inside the image, which stays in its own script.\n\n## Output format\n\n- Return the description and nothing else: one continuous paragraph of English, in a single line\nstarting on the very first character of your reply.\n- No JSON, no braces, no key names, no labels, no headings, no markdown, no code fences, and no quotation marks around the paragraph.\n- No preamble, no acknowledgement, no explanation, no summary, no notes, no closing remarks, no questions.\n- No ratio, no resolution, no pixel count, no timestamps.\n\nYour whole reply is used as the image prompt, so every extra word you add becomes part of the image.\n<|im_end|>"
            ],
            "widgets_values_named": {
              "value": "<|im_start|>system\n# Image Prompt Rewriting Expert\n\nYou turn a user's image request into one long English paragraph that describes the\nfinished image as if you were looking at it, plus the aspect ratio it should be\nrendered at. You are not talking to the user and not talking to a renderer: you are\nan observer reporting what is in the frame.\n\nWork through the eight steps below in order. Each step commits one decision; later\nsteps never revise an earlier one.\n\n## Step 1 — Read the brief and split it in two\n\nList what the user has fixed and what they have left open.\n\nFixed, and it must survive into your description unchanged: every string of text\nthey want shown, every named object, every count, every stated colour, every stated\nposition, and the aspect ratio if they gave one. Copy their text strings character\nfor character, in their own script, including punctuation and spacing.\n\nA third thing they may give you is an instruction about the job rather than about the\npicture — \"use double quotes\", \"no hard-edged blocks\", \"4K, no noise\", \"make sure the\ntext is sharp\". That is not content. Obey it silently where it applies and never echo\nit: the description states what is in the frame, never what must be done.\n\nOpen, and you must decide it: everything they did not mention. A three-word request\nand a three-hundred-word request both become a description of the same size, so a\nshort brief means you are inventing most of the frame, not writing less.\n\n## Step 2 — Fix the frame\n\nDecide the orientation from the subject, then pick the ratio.\n\nIf the user states a ratio, use it. Otherwise: `3:2` for anything horizontal and\n`2:3` for anything vertical — these are the two defaults and cover most images.\nUse `1:1` for a square badge, icon, album cover or single centred emblem, `16:9`\nfor a wide cinematic or presentation frame, `1:2` or `9:16` for a phone screen or a\ntall standing banner. `3:4`, `2:1`, `21:9`, `4:3`, `9:21`, `4:5`, `3:1`, `5:4`,\n`1:3` exist but only when the subject or the user really calls for them.\n\nThe ratio lives only in the `wh_ratio` field. Never write a ratio, a resolution, or\na pixel count into the description itself.\n\n## Step 3 — Write the opening sentence\n\nOne sentence, around twenty words. Name the medium, the style, the subject, and the\nbackground or palette; usually name the orientation too:\n\n`The image is a ⟨vertical / wide / square / tall⟩ ⟨style⟩ ⟨photograph · poster · illustration · scene · portrait · infographic · close-up · graphic · page · card · sheet · logo⟩ of ⟨subject⟩, ⟨the background and its palette⟩.`\n\n`This is a …` or a bare `A vertical realistic photograph of …` work equally well. The\nmedium noun is the one part that is never omitted.\n\nThe style word goes here — realistic, photorealistic, minimalist, flat-vector,\ncinematic, watercolour, isometric, editorial, hand-drawn, 3D-rendered, retro. Name\nit once here; you may echo it in the closing sentence.\n\n## Step 4 — Inventory before you write\n\nBefore any more prose, settle two lists.\n\nEvery element that will appear, each with a place in the frame: upper-left,\nacross the top, on the far right, in the lower-third, in the centre, in front of,\nbehind, tucked into the corner. You will need eight to fourteen such positional\nphrases, about ten typically, and they must reach the corners, the edges and the\ncentre — not cluster in the middle.\n\nEvery piece of text that will be legible in the image, in reading order.\n\n## Step 5 — Walk the frame\n\nNow describe it in order. Which order depends on how the frame is filled.\n\n**If the frame is divided into regions** — a poster, a page, an interface, a layout, a\nwide scene with several things in it — walk the regions:\n\n1. The background and the surface it sits on — this comes immediately after the\n   opening sentence, not at the end.\n2. The top band: headline, header bar, sky, ceiling, whatever occupies the top edge.\n3. Down and across the body of the frame: left side, then centre, then right side.\n   Give each region one or two sentences.\n4. The bottom band: footer, foreground, ground plane, base row.\n\n**If one subject fills the frame** — a portrait, a close-up, a single object — walk\nthe subject instead: the background and how far it falls off, then the subject's pose\nand where it is placed in the frame, then head and face, then body and each garment or\nsurface, then what is held or touching it, then whatever little is left at the edges.\nKeep using positional phrases inside the subject — in the upper-left of the frame,\nbehind the left shoulder, along the lower edge — so the frame stays locatable.\n\nRoughly a third of your sentences should open on the positional phrase itself —\n\"On the right side of the frame, …\", \"In the upper-left corner, …\", \"Across the\nlower third, …\" — so the reader always knows where they are looking.\n\nKeep it to one paragraph. Break to a new paragraph only when the image is genuinely\nbuilt from stacked regions — panels, cards, sections, slides — and then one\nparagraph per region, each opening on where that region sits.\n\n## Step 6 — Set every piece of text\n\nSkip this step if nothing in the image is meant to be read — a third of images have\nno legible text at all, and inventing signage for them is a mistake.\n\nOtherwise, for each string from your Step 4 list, in reading order, name where it sits,\nwhat it looks like, and what it says: `a bold black headline across the top reads \"…\"`.\n\nPut the string in straight double quotes, in its own script — Chinese, Russian,\nKorean, Japanese and Arabic text stays in Chinese, Russian, Korean, Japanese and\nArabic. Give its weight, colour, case and relative size. Describe a line break as a\nsecond line rather than putting a real newline inside the string. If a mark is not meant\nto be read — distant signage, a label behind glass, dense body copy — call it\nblurred, indistinct, or too small to read rather than inventing letters. If the image contains a chart\nor a table, its axes, tick labels, legend entries, series and cell values are text\ntoo: write them out.\n\n## Step 7 — Give the lighting its own sentence\n\nEvery image has light in it, and the description always accounts for it: the source,\nits direction, its quality, and the shadows and highlights it leaves. Soft diffused\ndaylight from a window on the left, hard overhead studio light, warm low sun, flat\neven ambient light for a diagram.\n\nOnce the contents are placed, give it a sentence of its own — `The lighting is …` —\nor, if the light is what makes a particular surface look the way it does, fold it into\nthat surface's sentence. Either way it is stated explicitly, not left implied.\n\n## Step 8 — Close with the whole frame\n\nEnd on a single sentence that steps back:\n\n`The overall composition ⟨is / uses / feels⟩ …`\n\n`The composition is …`, `The overall design …`, `The overall mood …`, `The overall\npalette …` and `The image has …` are the same move. Cover balance and symmetry, the\npalette, the style, and the mood in that one sentence. Write exactly one such\nsentence — do not follow it with a second summary.\n\n## Throughout\n\n**Size.** The description runs about twenty sentences and four to five hundred words,\nroughly twenty-five words a sentence. That is the same size whether the brief was three\nwords or three hundred: a dense frame with many regions and a lot of text runs longer, a\nsingle quiet subject runs shorter, but a thin brief never buys a thin description.\n\n**Observe, don't instruct.** Present tense, third person, declarative. No \"you\", no\n\"create\", no \"make sure\", no \"the AI should\". No quality boosters — no \"masterpiece\",\n\"8K\", \"highly detailed\", \"award-winning\".\n\n**Hedge what you cannot be certain of.** An observer describing a picture says\n\"appears to be\", \"likely\", \"suggesting\", and offers a pair — \"a notebook\nor a tablet\", \"wood or dark laminate\" — when the thing is genuinely ambiguous. Do\nthis often; it is the natural register here. Be flatly definite only about what the\nuser fixed.\n\n**Name colours with a modifier, almost never bare.** Deep navy, muted olive, pale\ncream, warm terracotta, soft dusty rose, blue-grey, off-white, charcoal, brownish-\ngreen. Hex codes only if the user gave them.\n\n**Give the material, not just the noun.** Brushed metal, matte plastic, glossy\nceramic, coarse linen, weathered wood, frosted glass, grain, scuffs, condensation,\nvisible brush strokes, paper fibre.\n\n**Enumerate; never summarise.** \"Several items\" and \"various decorations\" are not\ndescriptions. Say what each thing is. Write small counts as words — three, five,\ntwelve — and if something is partly hidden, say so and describe the visible part.\n\n**People get their observable surface.** Build, posture, where they are looking,\nexpression, hair, skin tone, and each garment with its colour and material. Age is a\nlife stage or a decade — a child, a teenager, a young adult, middle-aged, elderly,\nin her thirties — never a number of years. If a face is turned away or cropped, say\nthat instead of describing it.\n\n**Objects by class, not by brand.** A silver laptop, a mirrorless camera, a compact\nhatchback — unless the user named the brand. Photographic and design vocabulary is\nwelcome: shallow depth of field, bokeh, backlit, close-up, negative space,\ngrid, drop shadow.\n\n**Everything holds together physically.** Shadows fall away from the light, reflections\nmatch what is in front of the surface, scale is consistent between neighbouring\nobjects, and a surface reacts to what sits on it. If the user asked for something\nimpossible, describe it as the image shows it and let the rest of the scene stay\ncoherent around it.\n\n## Language\n\nThe description is always in English, whatever language the request arrives in. The\nonly exception is text shown inside the image, which stays in its own script.\n\n## Output format\n\n- Return the description and nothing else: one continuous paragraph of English, in a single line\nstarting on the very first character of your reply.\n- No JSON, no braces, no key names, no labels, no headings, no markdown, no code fences, and no quotation marks around the paragraph.\n- No preamble, no acknowledgement, no explanation, no summary, no notes, no closing remarks, no questions.\n- No ratio, no resolution, no pixel count, no timestamps.\n\nYour whole reply is used as the image prompt, so every extra word you add becomes part of the image.\n<|im_end|>"
            }
          },
          {
            "id": 480,
            "type": "QwenImage21Cache",
            "pos": [
              1190,
              460
            ],
            "size": [
              270,
              90
            ],
            "flags": {},
            "order": 12,
            "mode": 0,
            "inputs": [
              {
                "localized_name": "model",
                "name": "model",
                "type": "MODEL",
                "link": 701
              },
              {
                "localized_name": "device",
                "name": "device",
                "type": "COMBO",
                "widget": {
                  "name": "device"
                },
                "link": 703
              },
              {
                "localized_name": "dtype",
                "name": "dtype",
                "type": "COMBO",
                "widget": {
                  "name": "dtype"
                },
                "link": 704
              }
            ],
            "outputs": [
              {
                "localized_name": "模型",
                "name": "MODEL",
                "type": "MODEL",
                "links": [
                  700
                ]
              }
            ],
            "properties": {
              "Node name for S&R": "QwenImage21Cache"
            },
            "widgets_values": [
              "auto",
              "default"
            ],
            "widgets_values_named": {
              "device": "auto",
              "dtype": "default"
            }
          }
        ],
        "groups": [
          {
            "id": 34,
            "title": "Models",
            "bounding": [
              -200,
              300,
              530,
              590
            ],
            "color": "#3f789e",
            "flags": {}
          },
          {
            "id": 35,
            "title": "Image Size",
            "bounding": [
              -200,
              920,
              530,
              250
            ],
            "color": "#3f789e",
            "flags": {}
          },
          {
            "id": 36,
            "title": "Conditioning",
            "bounding": [
              360,
              300,
              700,
              860
            ],
            "color": "#3f789e",
            "flags": {}
          },
          {
            "id": 37,
            "title": "Sampling",
            "bounding": [
              1090,
              300,
              470,
              860
            ],
            "color": "#3f789e",
            "flags": {}
          },
          {
            "id": 38,
            "title": "Prompt Enhancer",
            "bounding": [
              -200,
              -500,
              1760,
              770
            ],
            "color": "#3f789e",
            "flags": {}
          }
        ],
        "links": [
          {
            "id": 647,
            "origin_id": 453,
            "origin_slot": 0,
            "target_id": 452,
            "target_slot": 0,
            "type": "CLIP"
          },
          {
            "id": 649,
            "origin_id": 454,
            "origin_slot": 0,
            "target_id": 457,
            "target_slot": 1,
            "type": "VAE"
          },
          {
            "id": 650,
            "origin_id": 457,
            "origin_slot": 0,
            "target_id": -20,
            "target_slot": 0,
            "type": "IMAGE"
          },
          {
            "id": 651,
            "origin_id": 458,
            "origin_slot": 0,
            "target_id": 457,
            "target_slot": 0,
            "type": "LATENT"
          },
          {
            "id": 653,
            "origin_id": 452,
            "origin_slot": 0,
            "target_id": 458,
            "target_slot": 1,
            "type": "CONDITIONING"
          },
          {
            "id": 654,
            "origin_id": 456,
            "origin_slot": 0,
            "target_id": 458,
            "target_slot": 3,
            "type": "LATENT"
          },
          {
            "id": 655,
            "origin_id": 452,
            "origin_slot": 1,
            "target_id": 458,
            "target_slot": 2,
            "type": "CONDITIONING"
          },
          {
            "id": 686,
            "origin_id": 474,
            "origin_slot": 0,
            "target_id": 472,
            "target_slot": 0,
            "type": "STRING"
          },
          {
            "id": 687,
            "origin_id": 472,
            "origin_slot": 0,
            "target_id": 452,
            "target_slot": 3,
            "type": "STRING"
          },
          {
            "id": 700,
            "origin_id": 480,
            "origin_slot": 0,
            "target_id": 458,
            "target_slot": 0,
            "type": "MODEL"
          },
          {
            "id": 701,
            "origin_id": 451,
            "origin_slot": 0,
            "target_id": 480,
            "target_slot": 0,
            "type": "MODEL"
          },
          {
            "id": 684,
            "origin_id": -10,
            "origin_slot": 0,
            "target_id": 474,
            "target_slot": 0,
            "type": "STRING"
          },
          {
            "id": 688,
            "origin_id": -10,
            "origin_slot": 1,
            "target_id": 474,
            "target_slot": 2,
            "type": "BOOLEAN"
          },
          {
            "id": 657,
            "origin_id": -10,
            "origin_slot": 3,
            "target_id": 452,
            "target_slot": 4,
            "type": "STRING"
          },
          {
            "id": 658,
            "origin_id": -10,
            "origin_slot": 4,
            "target_id": 458,
            "target_slot": 6,
            "type": "FLOAT"
          },
          {
            "id": 659,
            "origin_id": -10,
            "origin_slot": 5,
            "target_id": 458,
            "target_slot": 5,
            "type": "INT"
          },
          {
            "id": 660,
            "origin_id": -10,
            "origin_slot": 6,
            "target_id": 456,
            "target_slot": 0,
            "type": "INT"
          },
          {
            "id": 661,
            "origin_id": -10,
            "origin_slot": 7,
            "target_id": 456,
            "target_slot": 1,
            "type": "INT"
          },
          {
            "id": 662,
            "origin_id": -10,
            "origin_slot": 8,
            "target_id": 458,
            "target_slot": 7,
            "type": "COMBO"
          },
          {
            "id": 668,
            "origin_id": -10,
            "origin_slot": 9,
            "target_id": 458,
            "target_slot": 8,
            "type": "COMBO"
          },
          {
            "id": 667,
            "origin_id": -10,
            "origin_slot": 10,
            "target_id": 458,
            "target_slot": 4,
            "type": "INT"
          },
          {
            "id": 663,
            "origin_id": -10,
            "origin_slot": 11,
            "target_id": 451,
            "target_slot": 0,
            "type": "COMBO"
          },
          {
            "id": 664,
            "origin_id": -10,
            "origin_slot": 12,
            "target_id": 453,
            "target_slot": 0,
            "type": "COMBO"
          },
          {
            "id": 665,
            "origin_id": -10,
            "origin_slot": 13,
            "target_id": 454,
            "target_slot": 0,
            "type": "COMBO"
          },
          {
            "id": 696,
            "origin_id": -10,
            "origin_slot": 14,
            "target_id": 473,
            "target_slot": 0,
            "type": "COMBO"
          },
          {
            "id": 703,
            "origin_id": -10,
            "origin_slot": 15,
            "target_id": 480,
            "target_slot": 1,
            "type": "COMBO"
          },
          {
            "id": 704,
            "origin_id": -10,
            "origin_slot": 16,
            "target_id": 480,
            "target_slot": 2,
            "type": "COMBO"
          },
          {
            "id": 712,
            "origin_id": 471,
            "origin_slot": 0,
            "target_id": 474,
            "target_slot": 1,
            "type": "STRING"
          },
          {
            "id": 681,
            "origin_id": 473,
            "origin_slot": 0,
            "target_id": 471,
            "target_slot": 0,
            "type": "CLIP"
          },
          {
            "id": 709,
            "origin_id": 475,
            "origin_slot": 0,
            "target_id": 471,
            "target_slot": 4,
            "type": "STRING"
          },
          {
            "id": 711,
            "origin_id": -10,
            "origin_slot": 0,
            "target_id": 471,
            "target_slot": 5,
            "type": "STRING"
          },
          {
            "id": 695,
            "origin_id": -10,
            "origin_slot": 2,
            "target_id": 471,
            "target_slot": 7,
            "type": "BOOLEAN"
          },
          {
            "id": 697,
            "origin_id": -10,
            "origin_slot": 10,
            "target_id": 471,
            "target_slot": 6,
            "type": "INT"
          }
        ],
        "extra": {}
      }
    ]
  },
  "config": {},
  "extra": {
    "frontendVersion": "1.53.6",
    "VHS_latentpreview": false,
    "VHS_latentpreviewrate": 0,
    "VHS_MetadataImage": true,
    "VHS_KeepIntermediate": true,
    "ds": {
      "scale": 0.8617765246183244,
      "offset": [
        -157.1766093468457,
        -2248.7133874658794
      ]
    }
  },
  "version": 0.4
}
